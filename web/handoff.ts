/** Hands a PDF rendered in the editor to the bilaga flow without a round trip through storage. */
let pending: { parentId: string; file: File } | null = null;
export function handOff(parentId: string, file: File) { pending = { parentId, file }; }
export function takeHandOff(parentId: string) {
  if (pending?.parentId !== parentId) return null;
  const { file } = pending; pending = null;
  return file;
}
