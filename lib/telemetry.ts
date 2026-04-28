type TelemetryValue = string | number | boolean | null | undefined;
type TelemetryProperties = Record<string, TelemetryValue>;

type ConnectionInfo = {
  instrumentationKey: string;
  ingestionEndpoint: string;
};

const parseConnectionString = (): ConnectionInfo | null => {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) return null;

  const entries = Object.fromEntries(
    connectionString
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        return separatorIndex > 0
          ? [part.slice(0, separatorIndex), part.slice(separatorIndex + 1)]
          : [part, ""];
      }),
  );

  const instrumentationKey = entries.InstrumentationKey;
  if (!instrumentationKey) return null;

  return {
    instrumentationKey,
    ingestionEndpoint: entries.IngestionEndpoint || "https://dc.services.visualstudio.com/",
  };
};

const toTelemetryProperties = (
  properties: TelemetryProperties = {},
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );

const formatDuration = (durationMs: number): string => {
  const safeMs = Math.max(0, Math.round(durationMs));
  const milliseconds = safeMs % 1000;
  const totalSeconds = Math.floor(safeMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
};

const postTelemetry = async (payload: unknown): Promise<void> => {
  const connection = parseConnectionString();
  if (!connection) return;

  const endpoint = `${connection.ingestionEndpoint.replace(/\/+$/, "")}/v2/track`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    console.warn("Application Insights telemetry ingestion failed", {
      status: response.status,
      details,
    });
  }
};

const createEnvelope = (
  telemetryType: "Event" | "RemoteDependency" | "Exception",
  baseType: "EventData" | "RemoteDependencyData" | "ExceptionData",
  baseData: Record<string, unknown>,
): Record<string, unknown> | null => {
  const connection = parseConnectionString();
  if (!connection) return null;

  return {
    name: `Microsoft.ApplicationInsights.${connection.instrumentationKey}.${telemetryType}`,
    time: new Date().toISOString(),
    iKey: connection.instrumentationKey,
    tags: {
      "ai.cloud.role": "sora-app",
      "ai.application.ver": process.env.CONTAINER_APP_REVISION || "local",
    },
    data: {
      baseType,
      baseData,
    },
  };
};

export const trackAiEvent = async (
  name: string,
  properties?: TelemetryProperties,
  measurements?: Record<string, number>,
): Promise<void> => {
  const envelope = createEnvelope("Event", "EventData", {
    ver: 2,
    name,
    properties: toTelemetryProperties({
      "service.name": "sora-app",
      "azure.resource_group": "VidSim",
      "ai_foundry.project": "vidsim-project",
      ...properties,
    }),
    measurements,
  });
  if (envelope) await postTelemetry(envelope);
};

export const trackAiDependency = async ({
  name,
  target,
  data,
  durationMs,
  success,
  resultCode,
  properties,
}: {
  name: string;
  target: string;
  data?: string;
  durationMs: number;
  success: boolean;
  resultCode?: string | number;
  properties?: TelemetryProperties;
}): Promise<void> => {
  const envelope = createEnvelope("RemoteDependency", "RemoteDependencyData", {
    ver: 2,
    name,
    id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
    resultCode: resultCode === undefined ? undefined : String(resultCode),
    duration: formatDuration(durationMs),
    success,
    data,
    target,
    type: "Azure AI",
    properties: toTelemetryProperties({
      "service.name": "sora-app",
      "azure.resource_group": "VidSim",
      "ai_foundry.project": "vidsim-project",
      "gen_ai.system": "azure.ai.foundry",
      ...properties,
    }),
  });
  if (envelope) await postTelemetry(envelope);
};

export const trackAiException = async (
  error: unknown,
  properties?: TelemetryProperties,
): Promise<void> => {
  const exception = error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "Unknown error");

  const envelope = createEnvelope("Exception", "ExceptionData", {
    ver: 2,
    exceptions: [
      {
        typeName: exception.name,
        message: exception.message,
        hasFullStack: Boolean(exception.stack),
        stack: exception.stack,
      },
    ],
    severityLevel: 3,
    properties: toTelemetryProperties({
      "service.name": "sora-app",
      "azure.resource_group": "VidSim",
      "ai_foundry.project": "vidsim-project",
      ...properties,
    }),
  });
  if (envelope) await postTelemetry(envelope);
};
