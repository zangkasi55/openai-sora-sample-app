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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let videoCfg;
  try {
    videoCfg = getAzureOpenAIVideoEndpoint();
  } catch (error) {
    const message = describeError(error, "Azure OpenAI video configuration error");
    return Response.json({ error: { message } }, { status: 500 });
  }
  const azureEndpoint = videoCfg.endpoint;

  const { id } = await params;
  const videoId = typeof id === "string" ? id.trim() : "";
  if (!videoId) {
    return Response.json(
      { error: { message: "Video id is required" } },
      { status: 400 }
    );
  }

  try {
    // For Azure OpenAI, construct the endpoint for video status
    const endpoint = buildAzureOpenAIUrl(
      azureEndpoint,
      `/openai/v1/videos/${encodeURIComponent(videoId)}`,
      videoCfg.apiVersion,
    );
    const authHeaders = await videoCfg.getAuthHeaders();
    const headers = {
      ...authHeaders,
    };

    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "GET",
      headers,
    });

    const video = await response.json().catch(() => null);
    await trackAiDependency({
      name: "sora video status",
      target: new URL(azureEndpoint).host,
      data: endpoint,
      durationMs: Date.now() - startedAt,
      success: response.ok,
      resultCode: response.status,
      properties: {
        "gen_ai.operation.name": "video.status",
        "gen_ai.request.model": "sora-2",
        "azure.ai.endpoint": new URL(azureEndpoint).host,
        "azure.ai.deployment": "sora-2",
        videoId,
        "http.response.status_code": response.status,
      },
    });
    if (!response.ok || !video) {
      const message = describeError(video, "Failed to fetch video");
      const derivedStatus = video ? resolveErrorStatus(video) : undefined;
      const status =
        typeof derivedStatus === "number" && derivedStatus > 0
          ? derivedStatus
          : response.status || 500;
      return Response.json({ error: { message } }, { status });
    }

    const videoRecord = isRecord(video) ? video : {};

    const prompt =
      typeof videoRecord.prompt === "string" && videoRecord.prompt.trim()
        ? videoRecord.prompt.trim()
        : "";

    const fallback: VideoRequestPayload = {
      prompt,
      model: coerceVideoModel(
        typeof videoRecord.model === "string" ? videoRecord.model : null
      ),
      size: coerceVideoSize(
        typeof videoRecord.size === "string" ? videoRecord.size : null
      ),
      seconds: coerceVideoSeconds(
        videoRecord.seconds !== undefined && videoRecord.seconds !== null
          ? String(videoRecord.seconds)
          : null
      ),
    };

    const normalized = normalizeVideoResponse(video, fallback);
    await trackAiEvent("video.status.checked", {
      model: normalized.model,
      videoId: normalized.id,
      status: normalized.status,
      success: true,
    }, {
      durationMs: Date.now() - startedAt,
    });
    return Response.json(normalized);
  } catch (error) {
    await trackAiException(error, { operation: "video.status", videoId });
    const message = describeError(error, "Failed to fetch video");
    const status = resolveErrorStatus(error);
    return Response.json({ error: { message } }, { status });
  }
}
