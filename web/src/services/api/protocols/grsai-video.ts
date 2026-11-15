import { firstHTTPURL, firstString, normalizeDirectStatus, readDirectError, readNumber, readPath } from "./shared";

export const GRSAI_VIDEO_GENERATE_PATH = "/v1/api/generate";
export const GRSAI_VIDEO_RESULT_PATH = "/v1/api/result";

export function grsaiVideoBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function grsaiVideoResultUrl(baseUrl: string, id: string) {
    const url = new URL(`${grsaiVideoBaseUrl(baseUrl)}${GRSAI_VIDEO_RESULT_PATH}`);
    url.searchParams.set("id", id);
    return url.href;
}

export function grsaiVideoGenerateUrl(baseUrl: string) {
    return `${grsaiVideoBaseUrl(baseUrl)}${GRSAI_VIDEO_GENERATE_PATH}`;
}

export function readGrsaiVideoTaskId(payload: unknown) {
    return firstString(
        readPath(payload, "id"), readPath(payload, "taskId"), readPath(payload, "task_id"),
        readPath(payload, "data.id"), readPath(payload, "data.taskId"), readPath(payload, "data.task_id"),
        readPath(payload, "task.id"), readPath(payload, "data.task.id"),
    );
}

export function readGrsaiVideoError(payload: unknown) {
    return firstString(
        readPath(payload, "failMsg"), readPath(payload, "data.failMsg"),
        readPath(payload, "error.message"), readPath(payload, "data.error.message"),
        readDirectError(payload),
    );
}

export function normalizeGrsaiVideoTask(payload: unknown, id: string, model: string) {
    const taskId = readGrsaiVideoTaskId(payload) || id;
    const statusValue = firstString(readPath(payload, "status"), readPath(payload, "data.status"), readPath(payload, "state"));
    const url = firstHTTPURL(readPath(payload, "results")) || firstHTTPURL(readPath(payload, "data.results")) || firstHTTPURL(readPath(payload, "video_url")) || firstHTTPURL(readPath(payload, "data.video_url"));
    const error = readGrsaiVideoError(payload);
    const normalizedStatus = statusValue.toLowerCase() === "expired" ? "failed" : normalizeDirectStatus(statusValue || (url ? "succeeded" : error ? "failed" : "processing"));
    return {
        id: taskId,
        task_id: taskId,
        status: normalizedStatus,
        ...(readNumber(readPath(payload, "progress")) !== undefined ? { progress: readNumber(readPath(payload, "progress")) } : {}),
        ...(url ? { url, video_url: url } : {}),
        ...(error ? { error: { message: error } } : {}),
        model,
    };
}
