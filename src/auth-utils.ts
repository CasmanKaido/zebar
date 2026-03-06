import crypto from "crypto";

export function normalizeBearerToken(value?: string): string {
    if (!value) return "";
    return value.replace(/^Bearer\s+/i, "").trim();
}

export function constantTimeSecretEqual(provided: string, expected: string): boolean {
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");

    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}
