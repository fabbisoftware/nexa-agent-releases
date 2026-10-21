// Which platform a native file (addon or executable) runs on, read from its header.
// Copy of scripts/release/lib/natives.mjs in the NEXA repo (the two repos share no code):
// the agent assembler uses it to keep only the target platform's binaries in an archive.
import { closeSync, openSync, readSync } from "node:fs";

const ELF_MACHINE = { 0x3e: "x64", 0xb7: "arm64" };
const MACHO_CPU = { 0x01000007: "x64", 0x0100000c: "arm64" };
const PE_MACHINE = { 0x8664: "x64", 0xaa64: "arm64" };

/**
 * @param {Buffer} buf the first bytes of the file (4 KiB is plenty)
 * @returns {{ os: "linux" | "darwin" | "win32", arch: string[] } | null} null when not a native binary
 */
export function nativeKind(buf) {
  if (buf.length >= 20 && buf[0] === 0x7f && buf.toString("latin1", 1, 4) === "ELF") {
    const little = buf[5] === 1;
    const machine = little ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    return { os: "linux", arch: [ELF_MACHINE[machine] ?? `elf:${machine}`] };
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    return { os: "darwin", arch: [MACHO_CPU[cpu] ?? `macho:${cpu}`] };
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xcafebabe) {
    // Universal binary (Java class files share the magic but have a version, not an arch count, here).
    const count = buf.readUInt32BE(4);
    if (count > 0 && count < 10 && buf.length >= 8 + count * 20) {
      const arch = Array.from({ length: count }, (_, i) => MACHO_CPU[buf.readUInt32BE(8 + i * 20)] ?? `macho:${buf.readUInt32BE(8 + i * 20)}`);
      return { os: "darwin", arch };
    }
    return null;
  }
  if (buf.length >= 64 && buf.toString("latin1", 0, 2) === "MZ") {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 <= buf.length && buf.toString("latin1", pe, pe + 4) === "PE\0\0") {
      const machine = buf.readUInt16LE(pe + 4);
      return { os: "win32", arch: [PE_MACHINE[machine] ?? `pe:${machine}`] };
    }
  }
  return null;
}

export function nativeKindOfFile(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return nativeKind(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** `<os>-<arch>` targets the bundle ships natives for; `node` names the process.platform value. */
export const TARGETS = [
  { id: "darwin-arm64", os: "darwin", arch: "arm64" },
  { id: "darwin-x64", os: "darwin", arch: "x64" },
  { id: "linux-x64", os: "linux", arch: "x64" },
  { id: "linux-arm64", os: "linux", arch: "arm64" },
  { id: "win32-x64", os: "win32", arch: "x64" },
];

export const runsOn = (kind, target) => kind !== null && kind.os === target.os && kind.arch.includes(target.arch);
