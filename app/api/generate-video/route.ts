import { Buffer } from "node:buffer";
import {
  coerceVideoModel,
  coerceVideoSeconds,
  coerceVideoSize,
  describeError,
  isRecord,
  normalizeVideoResponse,
  resolveErrorStatus,
  VideoRequestPayload,
} from "@/lib/sora";
import { buildAzureOpenAIUrl, getAzureOpenAIVideoEndpoint } from "@/lib/azure-openai";
import { trackAiDependency, trackAiEvent, trackAiException } from "@/lib/telemetry";

type VideoCreateParams = {
  prompt: string;
  model: string;
  size: string;
  seconds: string;
};

export async function POST(request: Request) {
  let videoCfg;
  try {
    videoCfg = getAzureOpenAIVideoEndpoint();
  } catch (error) {
    const message = describeError(error, "Azure OpenAI video configuration error");
    return Response.json({ error: { message } }, { status: 500 });
  }
  const azureEndpoint = videoCfg.endpoint;

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON payload" } },
      { status: 400 }
    );
  }

  const payload = isRecord(rawPayload) ? rawPayload : {};

  const prompt =
    typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return Response.json(
      { error: { message: "Prompt is required" } },
      { status: 400 }
    );
  }

  const model = coerceVideoModel(
    typeof payload.model === "string" ? payload.model : null
  );
  const size = coerceVideoSize(
    typeof payload.size === "string" ? payload.size : null
  );
  const seconds = coerceVideoSeconds(
    payload.seconds != null ? String(payload.seconds) : null
  );

  const imageData = isRecord(payload.image) ? payload.image : null;

  const videoPayload: VideoRequestPayload = {
    prompt,
    model,
    size,
    seconds,
  };

  try {
    // For Azure OpenAI, construct the endpoint for video generation
    const endpoint = buildAzureOpenAIUrl(
      azureEndpoint,
      "/openai/v1/videos",
      videoCfg.apiVersion,
    );
    const authHeaders = await videoCfg.getAuthHeaders();
    const headers: Record<string, string> = {
      ...authHeaders,
    };

    let response: Response;
    const startedAt = Date.now();
    if (imageData?.data != null) {
      const formData = new FormData();
      formData.set("prompt", prompt);
      formData.set("model", model);
      formData.set("size", size);
      formData.set("seconds", seconds);

      const buffer = Buffer.from(String(imageData.data), "base64");
      const mimeType =
        typeof imageData.mimeType === "string" && imageData.mimeType.trim()
          ? imageData.mimeType
          : "image/png";
      const filename =
        typeof imageData.name === "string" && imageData.name.trim()
          ? imageData.name.trim()
          : "input-reference";
      const blob = new Blob([buffer], { type: mimeType });
      formData.append("input_reference", blob, filename);

      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: formData,
      });
    } else {
      headers["Content-Type"] = "application/json";
      const payload: VideoCreateParams = {
        prompt,
        model,
        size,
        seconds,
      };
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    }

    const result = await response.json().catch(() => null);
    await trackAiDependency({
      name: "sora video create",
      target: new URL(azureEndpoint).host,
      data: endpoint,
      durationMs: Date.now() - startedAt,
      success: response.ok,
      resultCode: response.status,
      properties: {
        "gen_ai.operation.name": "video.generate",
        "gen_ai.request.model": model,
        "azure.ai.endpoint": new URL(azureEndpoint).host,
        "azure.ai.deployment": model,
        "azure.ai.has_reference_image": Boolean(imageData?.data),
        "http.response.status_code": response.status,
      },
    });
    if (!response.ok || !result) {
      const message = describeError(result, "Failed to create video");
      const derivedStatus = result ? resolveErrorStatus(result) : undefined;
      const status =
        typeof derivedStatus === "number" && derivedStatus > 0
          ? derivedStatus
          : response.status || 500;
      return Response.json({ error: { message } }, { status });
    }

    const normalized = normalizeVideoResponse(result, videoPayload);
    await trackAiEvent("video.generation.created", {
      model,
      size,
      seconds,
      hasReferenceImage: Boolean(imageData?.data),
      status: normalized.status,
      videoId: normalized.id,
      success: true,
    }, {
      durationMs: Date.now() - startedAt,
    });
    return Response.json(normalized);
  } catch (error) {
    console.error("generate-video error", error);
    await trackAiException(error, { operation: "video.generate", model: videoPayload.model });
    const message = describeError(error, "Failed to create video");
    const status = resolveErrorStatus(error);
    return Response.json({ error: { message } }, { status });
  }
}
