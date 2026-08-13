import coreAssetUrl from "@ffmpeg/core?url";
import wasmAssetUrl from "@ffmpeg/core/wasm?url";

export const ffmpegCorePublicPath = asExtensionPublicPath(coreAssetUrl);
export const ffmpegWasmPublicPath = asExtensionPublicPath(wasmAssetUrl);

function asExtensionPublicPath(assetUrl: string): string {
  const pathname = new URL(assetUrl, window.location.href).pathname;
  return pathname.replace(/^\/+/, "");
}
