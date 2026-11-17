export type PodMimeType = "application/pdf" | "image/jpeg";

export const POD_FILE_ACCEPT = ".pdf,.jpg,.jpeg,application/pdf,image/jpeg";

/** Resolve the MIME type the server validates against; browsers often leave `file.type` empty. */
export function podMimeTypeForFile(file: Pick<File, "name" | "type">): PodMimeType | null {
  const declared = String(file.type || "").split(";")[0].trim().toLowerCase();
  if (declared === "application/pdf" || declared === "image/jpeg") return declared;
  if (/\.pdf$/i.test(file.name)) return "application/pdf";
  if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
  return null;
}
