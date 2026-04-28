import { describeError, resolveErrorStatus } from "@/lib/sora";
import { buildAzureOpenAIUrl, getAzureOpenAIVideoEndpoint } from "@/lib/azure-openai";
import { trackAiDependency, trackAiEvent, trackAiException } from "@/lib/telemetry";

const asVariant = (value: string | null): "video" | "thumbnail" | "spritesheet" | undefined => {
  if (!value) return undefined;
  if (value === "video" || value === "thumbnail" || value === "spritesheet") {
    return value;
  }
  return undefined;
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    return Response.json({ error: { message: "Video id is required" } }, { status: 400 });
  }

  const url = new URL(request.url);
  const variant = asVariant(url.searchParams.get("variant"));

  try {
    // For Azure OpenAI, construct the endpoint for video content
    const endpoint = buildAzureOpenAIUrl(
      azureEndpoint,
      `/openai/v1/videos/${encodeURIComponent(videoId)}/content`,
      videoCfg.apiVersion,
      variant ? { variant } : {},
    );
    const authHeaders = await videoCfg.getAuthHeaders();
    const headers = {
      "Accept": "application/binary",
      ...authHeaders,
    };

    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "GET",
      headers,
    });
    await trackAiDependency({
      name: "sora video content",
      target: new URL(azureEndpoint).host,
      data: endpoint,
      durationMs: Date.now() - startedAt,
      success: response.ok,
      resultCode: response.status,
      properties: {
        "gen_ai.operation.name": "video.content",
        "gen_ai.request.model": "sora-2",
        "azure.ai.endpoint": new URL(azureEndpoint).host,
        "azure.ai.deployment": "sora-2",
        videoId,
        variant: variant ?? "video",
        "http.response.status_code": response.status,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to fetch video content");
      const message = describeError({ message: errorText }, "Failed to fetch video content");
      return Response.json({ error: { message } }, { status: response.status || 500 });
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type")
      || (variant === "thumbnail" ? "image/png" : "video/mp4");

    await trackAiEvent("video.content.downloaded", {
      videoId,
      variant: variant ?? "video",
      contentType,
      success: true,
    }, {
      durationMs: Date.now() - startedAt,
      bytes: arrayBuffer.byteLength,
    });
    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    await trackAiException(error, {
      operation: "video.content",
      videoId,
      variant: variant ?? "video",
    });
    const message = describeError(error, "Failed to fetch video content");
    const status = resolveErrorStatus(error);
    return Response.json({ error: { message } }, { status });
  }
}
