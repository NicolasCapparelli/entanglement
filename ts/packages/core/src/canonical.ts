/** Thrown when a value cannot be represented in canonical JSON. */
export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

/** A JSON object: the shape of every document. */
export type Json = { [key: string]: unknown };

/**
 * Encodes `value` as RFC 8785 (JCS) canonical JSON (spec §5.7).
 *
 * Every equality check in the framework — dirty detection, coalescing,
 * three-way decisions, digests — compares these strings, so this must produce
 * byte-identical output to the Dart implementation. JavaScript's own number and
 * string serialisation already follow ECMAScript, which is what JCS specifies;
 * only key ordering and the rejection of non-JSON values are added here.
 *
 * Unlike Dart, JavaScript cannot tell an integer beyond ±(2^53 − 1) from a
 * double, so such numbers are encoded rather than rejected. The spec forbids
 * them in documents either way.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(out, value);
  return out.join("");
}

/** Decodes a canonical document string into an object. */
export function decodeDocument(text: string): Json {
  const value: unknown = JSON.parse(text);
  if (!isPlainObject(value)) {
    throw new CanonicalJsonError("A document must be a JSON object.");
  }
  return value;
}

export function isPlainObject(value: unknown): value is Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(out: string[], value: unknown): void {
  if (value === null) {
    out.push("null");
  } else if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`Non-finite number ${value}.`);
    }
    // ECMAScript Number::toString, with -0 as "0" — exactly JCS.
    out.push(JSON.stringify(value));
  } else if (typeof value === "string") {
    // Well-formed JSON.stringify (ES2019): lone surrogates become \udxxx.
    out.push(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, index) => {
      if (index > 0) out.push(",");
      write(out, item === undefined ? null : item);
    });
    out.push("]");
  } else if (isPlainObject(value)) {
    // Default sort compares UTF-16 code units, which is what JCS wants.
    // Undefined properties are treated as absent, as JSON.stringify does.
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    out.push("{");
    keys.forEach((key, index) => {
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      write(out, value[key]);
    });
    out.push("}");
  } else {
    throw new CanonicalJsonError(`Unsupported value of type ${typeof value}.`);
  }
}
