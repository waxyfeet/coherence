/**
 * OWNER: server-core builder.
 * multer (memory storage) for screen uploads. Type checks happen in projectStore by magic bytes —
 * the browser-declared MIME type is only a hint, so it is not trusted here.
 */
import type { Request } from "express";
import multer from "multer";
import { BadRequestError } from "../errors";
import type { UploadedImage } from "../storage/projectStore";

export const MAX_UPLOAD_FILES = 50;
export const MAX_UPLOAD_FILE_MB = 25;

const upload = multer({
  storage: multer.memoryStorage(),
  // Browsers send UTF-8 file names; busboy's default (latin1) would garble "Écran d'accueil.png".
  defParamCharset: "utf8",
  limits: {
    fileSize: MAX_UPLOAD_FILE_MB * 1024 * 1024,
    files: MAX_UPLOAD_FILES,
    fields: 20,
    parts: MAX_UPLOAD_FILES + 20,
  },
});

/** Field "files": 1..50 images. */
export const uploadScreens = upload.array("files", MAX_UPLOAD_FILES);
/** Field "file": one image (replace). */
export const uploadSingleScreen = upload.single("file");

function toUploaded(file: Express.Multer.File): UploadedImage {
  return {
    originalName: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer,
  };
}

export function uploadedFiles(req: Request): UploadedImage[] {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length)
    throw new BadRequestError(
      "No images were received. Drop or choose at least one PNG, JPEG, WebP or GIF file.",
    );
  return files.map(toUploaded);
}

export function uploadedFile(req: Request): UploadedImage {
  if (!req.file)
    throw new BadRequestError(
      "No image was received. Choose a PNG, JPEG, WebP or GIF file.",
    );
  return toUploaded(req.file);
}
