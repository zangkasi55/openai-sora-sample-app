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
    return Response.json({ error: { message: "Invalid JSON payload" } }, { status: 400 });
  }

  const payload = isRecord(rawPayload) ? rawPayload : {};

  const videoId = typeof payload.videoId === "string" ? payload.videoId.trim() : "";
  if (!videoId) {
    return Response.json({ error: { message: "videoId is required" } }, { status: 400 });
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ error: { message: "Prompt is required" } }, { status: 400 });
  }

  const fallback: VideoRequestPayload = {
    prompt,
    model: coerceVideoModel(typeof payload.model === "string" ? payload.model : null),
    size: coerceVideoSize(typeof payload.size === "string" ? payload.size : null),
    seconds: coerceVideoSeconds(payload.seconds != null ? String(payload.seconds) : null),
  };

  try {
    // For Azure OpenAI, construct the endpoint for video remix
    const endpoint = buildAzureOpenAIUrl(
      azureEndpoint,
      `/openai/v1/videos/${encodeURIComponent(videoId)}/remix`,
      videoCfg.apiVersion,
    );
    const authHeaders = await videoCfg.getAuthHeaders();
    const headers = {
      "Content-Type": "application/json",
      ...authHeaders,
    };

    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt,
        model: fallback.model,
        size: fallback.size,
        seconds: fallback.seconds,
      }),
    });

    const result = await response.json().catch(() => null);
    await trackAiDependency({
      name: "sora video remix",
      target: new URL(azureEndpoint).host,
      data: endpoint,
      durationMs: Date.now() - startedAt,
      success: response.ok,
      resultCode: response.status,
      properties: {
        "gen_ai.operation.name": "video.remix",
        "gen_ai.request.model": fallback.model,
        "azure.ai.endpoint": new URL(azureEndpoint).host,
        "azure.ai.deployment": fallback.model,
        videoId,
        "http.response.status_code": response.status,
      },
    });
    if (!response.ok || !result) {
      const message = describeError(result, "Failed to remix video");
      const derivedStatus = result ? resolveErrorStatus(result) : undefined;
      const status =
        typeof derivedStatus === "number" && derivedStatus > 0
          ? derivedStatus
          : response.status || 500;
      return Response.json({ error: { message } }, { status });
    }

    const normalized = normalizeVideoResponse(result, fallback);
    await trackAiEvent("video.remix.created", {
      model: fallback.model,
      size: fallback.size,
      seconds: fallback.seconds,
      sourceVideoId: videoId,
      videoId: normalized.id,
      status: normalized.status,
      success: true,
    }, {
      durationMs: Date.now() - startedAt,
    });
    return Response.json(normalized);
  } catch (error) {
    await trackAiException(error, {
      operation: "video.remix",
      model: fallback.model,
      videoId,
    });
    const message = describeError(error, "Failed to remix video");
    const status = resolveErrorStatus(error);
    return Response.json({ error: { message } }, { status });
  }
}
