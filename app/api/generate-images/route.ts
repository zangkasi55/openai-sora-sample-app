import { NextResponse } from "next/server";
import type { GeneratedImageSuggestion } from "@/types/generated";
import { describeError, resolveErrorStatus } from "@/lib/sora";
import {
  buildAzureOpenAIUrl,
  getAzureOpenAIAuthHeaders,
  getAzureOpenAIImageConfigs,
  getAzureMAIImageConfig,
} from "@/lib/azure-openai";
import { trackAiDependency, trackAiEvent, trackAiException } from "@/lib/telemetry";

const IMAGE_MODEL_FALLBACK = "gpt-image-2";
const MAI_IMAGE_MODEL = "MAI-Image-2";
const ALLOWED_IMAGE_MODELS = new Set<string>(["gpt-image-2", MAI_IMAGE_MODEL]);
const MAX_IMAGE_COUNT = 4;
const DEFAULT_IMAGE_COUNT = 3;
const MAX_GPT_IMAGE_ATTEMPTS_PER_DEPLOYMENT = 1;
const GPT_IMAGE_REQUEST_TIMEOUT_MS = 120_000;
const EXACT_REFERENCE_INSTRUCTIONS =
  "Reference image handling: the uploaded image is user-provided. First extract the primary subject or subjects from the uploaded reference image, including any human, animal, product, object, logo, prop, vehicle, clothing, scene element, color palette, texture, markings, proportions, and spatial relationships. Preserve the exact reference subject identity and details. For a human subject, preserve the exact real face, facial structure, expression, hairstyle, skin tone, age cues, wardrobe details, pose, silhouette, and overall identity. For non-human subjects, preserve the exact shape, material, color, texture, markings, labels, geometry, scale, and distinctive features. Apply the selected template to the background, layout, styling, lighting, camera, typography, and scene design unless the user explicitly asks to change the reference subject.";

type ImageSize =
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "768x1365"
  | "1024x1440"
  | "1024x1536"
  | "1365x768"
  | "1440x1024"
  | "1536x1024"
  | "1024x1792"
  | "1792x1024";

const DEFAULT_IMAGE_SIZE: ImageSize = "1024x1024";
const GPT_IMAGE_SIZES = new Set<ImageSize>([
  "1024x1024",
  "1024x1536",
  "1536x1024",
]);
const MAI_IMAGE_SIZES = new Set<ImageSize>([
  "1024x1024",
  "1365x768",
  "768x1365",
]);
const ALLOWED_IMAGE_SIZES = new Set<ImageSize>([
  "256x256",
  "512x512",
  "1024x1024",
  "768x1365",
  "1024x1440",
  "1024x1536",
  "1365x768",
  "1440x1024",
  "1536x1024",
  "1024x1792",
  "1792x1024",
]);

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string | null;
    url?: string | null;
  }>;
};

const toImageGenerationResponse = (
  payloads: ImageGenerationResponse[],
): ImageGenerationResponse => ({
  data: payloads.flatMap((payload) => payload.data ?? []),
});

interface GenerateImagesPayload {
  prompt?: unknown;
  size?: unknown;
  count?: unknown;
  model?: unknown;
  image?: unknown;
}

interface ImageInputPayload {
  data: string;
  mimeType?: string;
  name?: string;
}

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readImageInput = (value: unknown): ImageInputPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const data = readString(candidate.data);
  if (!data) return null;
  return {
    data: data.includes(",") ? data.split(",").pop() ?? data : data,
    mimeType: readString(candidate.mimeType) ?? "image/png",
    name: readString(candidate.name) ?? "reference-image.png",
  };
};

const readNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const coerceImageCount = (value: unknown): number => {
  const parsed = readNumber(value);
  if (parsed === null) return DEFAULT_IMAGE_COUNT;
  if (parsed <= 1) return 1;
  if (parsed >= MAX_IMAGE_COUNT) return MAX_IMAGE_COUNT;
  return Math.round(parsed);
};

const coerceImageModel = (value: unknown): string => {
  const candidate = readString(value);
  if (!candidate) return IMAGE_MODEL_FALLBACK;
  if (candidate.toLowerCase() === "mai") return MAI_IMAGE_MODEL;
  if (ALLOWED_IMAGE_MODELS.has(candidate)) return candidate;
  return IMAGE_MODEL_FALLBACK;
};

const coerceImageSize = (value: unknown): ImageSize => {
  const candidate = readString(value);
  if (!candidate) return DEFAULT_IMAGE_SIZE;
  if (ALLOWED_IMAGE_SIZES.has(candidate as ImageSize)) {
    return candidate as ImageSize;
  }
  return DEFAULT_IMAGE_SIZE;
};

const coerceImageSizeForModel = (value: unknown, model: string): ImageSize => {
  const size = coerceImageSize(value);
  if (model === MAI_IMAGE_MODEL) {
    return MAI_IMAGE_SIZES.has(size) ? size : DEFAULT_IMAGE_SIZE;
  }
  return GPT_IMAGE_SIZES.has(size) ? size : DEFAULT_IMAGE_SIZE;
};

const parseDimensions = (size: ImageSize): { width: number; height: number } => {
  const [widthRaw, heightRaw] = size.split("x");
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: 1024, height: 1024 };
  }
  return { width, height };
};

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const isRetryableImageStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

const getRetryDelayMs = (attempt: number, response: Response): number => {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(30_000, retryAfterSeconds * 1000);
  }
  return attempt === 0 ? 3_000 : 8_000;
};

const postGptImageRequest = async ({
  endpoint,
  authHeaders,
  prompt,
  size,
  count,
  model,
  image,
}: {
  endpoint: string;
  authHeaders: Record<string, string>;
  prompt: string;
  size: ImageSize;
  count: number;
  model: string;
  image: ImageInputPayload | null;
}): Promise<Response> => image
  ? fetch(endpoint, {
      method: "POST",
      headers: authHeaders,
      signal: AbortSignal.timeout(GPT_IMAGE_REQUEST_TIMEOUT_MS),
      body: (() => {
        const form = new FormData();
        const imageBuffer = Buffer.from(image.data, "base64");
        const imageBlob = new Blob([imageBuffer], {
          type: image.mimeType || "image/png",
        });
        form.set("image", imageBlob, image.name || "reference-image.png");
        form.set("prompt", prompt);
        form.set("n", String(count));
        form.set("quality", "medium");
        form.set("size", size);
        return form;
      })(),
    })
  : fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(GPT_IMAGE_REQUEST_TIMEOUT_MS),
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        n: count,
        output_format: "png",
        prompt,
        quality: "medium",
        size,
      }),
    });

const generateWithGptImage = async ({
  prompt,
  size,
  count,
  image,
}: {
  prompt: string;
  size: ImageSize;
  count: number;
  image: ImageInputPayload | null;
}): Promise<{ generation: ImageGenerationResponse | null; status: number; ok: boolean }> => {
  const effectivePrompt = image
    ? `${prompt}\n\n${EXACT_REFERENCE_INSTRUCTIONS}`
    : prompt;
  const configs = getAzureOpenAIImageConfigs();
  let lastGeneration: ImageGenerationResponse | null = null;
  let lastStatus = 500;

  for (const config of configs) {
    const basePath = `/openai/deployments/${encodeURIComponent(config.deploymentName)}/images`;
    const endpoint = buildAzureOpenAIUrl(
      config.endpoint,
      `${basePath}/${image ? "edits" : "generations"}`,
      config.apiVersion ?? "2025-04-01-preview",
    );
    const authHeaders = await getAzureOpenAIAuthHeaders(config.apiKey);

    for (let attempt = 0; attempt < MAX_GPT_IMAGE_ATTEMPTS_PER_DEPLOYMENT; attempt += 1) {
      let response: Response;
      const startedAt = Date.now();
      try {
        response = await postGptImageRequest({
          endpoint,
          authHeaders,
          prompt: effectivePrompt,
          size,
          count,
          model: config.deploymentName,
          image,
        });
      } catch (error) {
        await trackAiDependency({
          name: image ? "gpt-image-2 edits" : "gpt-image-2 generations",
          target: new URL(config.endpoint).host,
          data: endpoint,
          durationMs: Date.now() - startedAt,
          success: false,
          resultCode: 504,
          properties: {
            "gen_ai.operation.name": image ? "image.edit" : "image.generate",
            "gen_ai.request.model": config.deploymentName,
            "azure.ai.endpoint": new URL(config.endpoint).host,
            "azure.ai.deployment": config.deploymentName,
            "azure.ai.has_reference_image": Boolean(image),
            "azure.ai.attempt": attempt + 1,
          },
        });
        await trackAiException(error, {
          operation: image ? "gpt-image-2 edits" : "gpt-image-2 generations",
          deployment: config.deploymentName,
          endpointHost: new URL(config.endpoint).host,
        });
        lastGeneration = {
          data: [],
        };
        lastStatus = 504;
        console.warn("Image generation attempt timed out", {
          deployment: config.deploymentName,
          endpointHost: new URL(config.endpoint).host,
          hasReferenceImage: Boolean(image),
          message: error instanceof Error ? error.message : "Request timed out",
        });
        break;
      }
      const generation = (await response.json().catch(() => null)) as
        | ImageGenerationResponse
        | null;
      await trackAiDependency({
        name: image ? "gpt-image-2 edits" : "gpt-image-2 generations",
        target: new URL(config.endpoint).host,
        data: endpoint,
        durationMs: Date.now() - startedAt,
        success: response.ok,
        resultCode: response.status,
        properties: {
          "gen_ai.operation.name": image ? "image.edit" : "image.generate",
          "gen_ai.request.model": config.deploymentName,
          "azure.ai.endpoint": new URL(config.endpoint).host,
          "azure.ai.deployment": config.deploymentName,
          "azure.ai.has_reference_image": Boolean(image),
          "azure.ai.attempt": attempt + 1,
          "http.response.status_code": response.status,
        },
      });

      if (response.ok && generation) {
        console.log("Image generation succeeded", {
          deployment: config.deploymentName,
          endpointHost: new URL(config.endpoint).host,
          hasReferenceImage: Boolean(image),
        });
        return { generation, ok: true, status: response.status };
      }

      lastGeneration = generation;
      lastStatus = response.status;
      console.warn("Image generation attempt failed", {
        deployment: config.deploymentName,
        endpointHost: new URL(config.endpoint).host,
        status: response.status,
        hasReferenceImage: Boolean(image),
        retryable: isRetryableImageStatus(response.status),
      });
      if (!isRetryableImageStatus(response.status)) {
        break;
      }
      if (attempt < MAX_GPT_IMAGE_ATTEMPTS_PER_DEPLOYMENT - 1) {
        await sleep(getRetryDelayMs(attempt, response));
      }
    }
  }

  return {
    generation: lastGeneration,
    ok: false,
    status: lastStatus,
  };
};

const generateWithMaiImage = async ({
  prompt,
  size,
  count,
}: {
  prompt: string;
  size: ImageSize;
  count: number;
}): Promise<{ generation: ImageGenerationResponse | null; status: number; ok: boolean }> => {
  const config = getAzureMAIImageConfig();
  const endpoint = `${config.endpoint.replace(/\/+$/, "")}/mai/v1/images/generations`;
  const authHeaders = await getAzureOpenAIAuthHeaders(config.apiKey);
  const { width, height } = parseDimensions(size);
  const generations: ImageGenerationResponse[] = [];

  for (let index = 0; index < count; index += 1) {
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.deploymentName,
        prompt,
        width,
        height,
      }),
    });
    const generation = (await response.json().catch(() => null)) as
      | ImageGenerationResponse
      | null;
    await trackAiDependency({
      name: "MAI image generations",
      target: new URL(config.endpoint).host,
      data: endpoint,
      durationMs: Date.now() - startedAt,
      success: response.ok,
      resultCode: response.status,
      properties: {
        "gen_ai.operation.name": "image.generate",
        "gen_ai.request.model": config.deploymentName,
        "azure.ai.endpoint": new URL(config.endpoint).host,
        "azure.ai.deployment": config.deploymentName,
        "azure.ai.image_index": index,
        "http.response.status_code": response.status,
      },
    });
    if (!response.ok || !generation) {
      return { generation, ok: response.ok, status: response.status };
    }
    generations.push(generation);
  }

  return { generation: toImageGenerationResponse(generations), ok: true, status: 200 };
};

export async function POST(request: Request) {
  let rawPayload: GenerateImagesPayload;
  try {
    rawPayload = (await request.json()) as GenerateImagesPayload;
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON payload" } },
      { status: 400 }
    );
  }

  const prompt = readString(rawPayload.prompt);
  if (!prompt) {
    return NextResponse.json(
      { error: { message: "Prompt is required" } },
      { status: 400 }
    );
  }

  const image = readImageInput(rawPayload.image);
  const model = coerceImageModel(rawPayload.model);
  const size = coerceImageSizeForModel(rawPayload.size, model);
  const count = image || model === IMAGE_MODEL_FALLBACK
    ? 1
    : coerceImageCount(rawPayload.count);

  try {
    if (image && model === MAI_IMAGE_MODEL) {
      return NextResponse.json(
        {
          error: {
            message:
              "Reference images are supported for GPT-image-2. Switch the image model to GPT-image-2 to use the attached image.",
          },
        },
        { status: 400 },
      );
    }

    console.log("Image generation request", {
      model,
      size,
      count,
      hasReferenceImage: Boolean(image),
    });
    const requestStartedAt = Date.now();

    const result = model === MAI_IMAGE_MODEL
      ? await generateWithMaiImage({ prompt, size, count })
      : await generateWithGptImage({ prompt, size, count, image });

    const { generation } = result;
    if (!result.ok || !generation) {
      const rawMessage = describeError(generation, "Failed to generate images");
      const message = image && /safety system/i.test(rawMessage)
        ? `${rawMessage} The uploaded reference image was sent to GPT-image-2 with exact reference-subject preservation instructions, but Azure rejected this request. This is an Azure safety-system decision for the specific image or prompt.`
        : rawMessage;
      console.error("Image generation failed", {
        model,
        status: result.status,
        message,
      });
      await trackAiEvent("image.generation.completed", {
        model,
        size,
        count,
        hasReferenceImage: Boolean(image),
        success: false,
        status: result.status,
      }, {
        durationMs: Date.now() - requestStartedAt,
      });
      const derivedStatus = generation ? resolveErrorStatus(generation) : undefined;
      const status =
        typeof derivedStatus === "number" && derivedStatus > 0
          ? derivedStatus
          : result.status || 500;
      return NextResponse.json({ error: { message } }, { status });
    }

    const suggestions = (generation.data ?? []).reduce<GeneratedImageSuggestion[]>(
      (acc, entry, index) => {
        const base64 = entry.b64_json ?? null;
        const url = base64
          ? `data:image/png;base64,${base64}`
          : readString(entry.url);
        if (!url) return acc;
        acc.push({
          id: `generated-${Date.now()}-${index}`,
          url,
          base64,
          description: prompt,
          model,
          size,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        return acc;
      },
      [],
    );
    await trackAiEvent("image.generation.completed", {
      model,
      size,
      count,
      hasReferenceImage: Boolean(image),
      success: true,
      status: result.status,
      producedImages: suggestions.length,
    }, {
      durationMs: Date.now() - requestStartedAt,
    });

    return NextResponse.json({ images: suggestions });
  } catch (error) {
    await trackAiException(error, { operation: "image.generation", model });
    const message = describeError(error, "Failed to generate images");
    const status = resolveErrorStatus(error);
    return NextResponse.json({ error: { message } }, { status });
  }
}
