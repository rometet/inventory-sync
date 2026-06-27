export const TAG = Object.freeze({
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
});

export type TagType = (typeof TAG)[keyof typeof TAG];

export interface NbtTag {
  type: TagType;
  value: NbtValue;
}

export type NbtCompound = Map<string, NbtTag>;
export type NbtList = { elementType: TagType; values: NbtValue[] };
export type NbtValue = number | bigint | string | Buffer | NbtList | NbtCompound | number[] | bigint[];

class Reader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = Buffer.from(buffer);
  }

  get done(): boolean {
    return this.offset === this.buffer.length;
  }

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw new Error("NBT data ended unexpectedly.");
    }
  }

  private readUInt8(): number {
    this.ensure(1);
    return this.buffer.readUInt8(this.offset++);
  }

  private readInt8(): number {
    this.ensure(1);
    return this.buffer.readInt8(this.offset++);
  }

  private readInt16(): number {
    this.ensure(2);
    const value = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  private readUInt16(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  private readInt32(): number {
    this.ensure(4);
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  private readInt64(): bigint {
    this.ensure(8);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  private readFloat(): number {
    this.ensure(4);
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  private readDouble(): number {
    this.ensure(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  private readString(): string {
    const length = this.readUInt16();
    this.ensure(length);
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readByteArray(): Buffer {
    const length = this.readInt32();
    if (length < 0) {
      throw new Error("NBT byte array length was negative.");
    }
    this.ensure(length);
    const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  private readList(): NbtList {
    const elementType = this.readUInt8() as TagType;
    const length = this.readInt32();
    if (length < 0) {
      throw new Error("NBT list length was negative.");
    }

    const values: NbtValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(this.readPayload(elementType));
    }

    return { elementType, values };
  }

  private readCompound(): NbtCompound {
    const value: NbtCompound = new Map();
    while (true) {
      const type = this.readUInt8() as TagType;
      if (type === TAG.End) {
        return value;
      }

      const name = this.readString();
      value.set(name, { type, value: this.readPayload(type) });
    }
  }

  private readIntArray(): number[] {
    const length = this.readInt32();
    if (length < 0) {
      throw new Error("NBT int array length was negative.");
    }

    const values: number[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(this.readInt32());
    }

    return values;
  }

  private readLongArray(): bigint[] {
    const length = this.readInt32();
    if (length < 0) {
      throw new Error("NBT long array length was negative.");
    }

    const values: bigint[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(this.readInt64());
    }

    return values;
  }

  readRoot(): { rootName: string; root: NbtCompound } {
    const rootType = this.readUInt8();
    if (rootType !== TAG.Compound) {
      throw new Error("LE NBT root tag must be a compound.");
    }

    const rootName = this.readString();
    const root = this.readCompound();
    if (!this.done) {
      throw new Error("LE NBT had trailing bytes after the root compound.");
    }

    return { rootName, root };
  }

  private readPayload(type: TagType): NbtValue {
    switch (type) {
      case TAG.Byte:
        return this.readInt8();
      case TAG.Short:
        return this.readInt16();
      case TAG.Int:
        return this.readInt32();
      case TAG.Long:
        return this.readInt64();
      case TAG.Float:
        return this.readFloat();
      case TAG.Double:
        return this.readDouble();
      case TAG.ByteArray:
        return this.readByteArray();
      case TAG.String:
        return this.readString();
      case TAG.List:
        return this.readList();
      case TAG.Compound:
        return this.readCompound();
      case TAG.IntArray:
        return this.readIntArray();
      case TAG.LongArray:
        return this.readLongArray();
      default:
        throw new Error(`Unsupported NBT tag type ${type}.`);
    }
  }
}

function writeNumber(size: number, callback: (buffer: Buffer) => void): Buffer {
  const buffer = Buffer.alloc(size);
  callback(buffer);
  return buffer;
}

function writeString(value: unknown): Buffer {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length > 65535) {
    throw new Error("NBT string is too long.");
  }

  const length = Buffer.alloc(2);
  length.writeUInt16LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function writePayload(type: TagType, value: NbtValue): Buffer {
  switch (type) {
    case TAG.Byte:
      return writeNumber(1, (buffer) => buffer.writeInt8(Number(value), 0));
    case TAG.Short:
      return writeNumber(2, (buffer) => buffer.writeInt16LE(Number(value), 0));
    case TAG.Int:
      return writeNumber(4, (buffer) => buffer.writeInt32LE(Number(value), 0));
    case TAG.Long:
      return writeNumber(8, (buffer) => buffer.writeBigInt64LE(BigInt(value as bigint | number | string), 0));
    case TAG.Float:
      return writeNumber(4, (buffer) => buffer.writeFloatLE(Number(value), 0));
    case TAG.Double:
      return writeNumber(8, (buffer) => buffer.writeDoubleLE(Number(value), 0));
    case TAG.ByteArray: {
      const bytes = Buffer.from(value as Buffer);
      const length = writeNumber(4, (buffer) => buffer.writeInt32LE(bytes.length, 0));
      return Buffer.concat([length, bytes]);
    }
    case TAG.String:
      return writeString(value);
    case TAG.List: {
      const list = value as NbtList;
      const values = Array.isArray(list.values) ? list.values : [];
      const header = Buffer.alloc(5);
      header.writeUInt8(list.elementType, 0);
      header.writeInt32LE(values.length, 1);
      return Buffer.concat([header, ...values.map((entry) => writePayload(list.elementType, entry))]);
    }
    case TAG.Compound:
      return writeCompound(value as NbtCompound);
    case TAG.IntArray: {
      const values = Array.isArray(value) ? (value as number[]) : [];
      const length = writeNumber(4, (buffer) => buffer.writeInt32LE(values.length, 0));
      return Buffer.concat([
        length,
        ...values.map((entry) => writeNumber(4, (buffer) => buffer.writeInt32LE(Number(entry), 0))),
      ]);
    }
    case TAG.LongArray: {
      const values = Array.isArray(value) ? (value as bigint[]) : [];
      const length = writeNumber(4, (buffer) => buffer.writeInt32LE(values.length, 0));
      return Buffer.concat([
        length,
        ...values.map((entry) => writeNumber(8, (buffer) => buffer.writeBigInt64LE(BigInt(entry), 0))),
      ]);
    }
    default:
      throw new Error(`Unsupported NBT tag type ${type}.`);
  }
}

function writeNamedTag(name: string, tag: NbtTag): Buffer {
  return Buffer.concat([Buffer.from([tag.type]), writeString(name), writePayload(tag.type, tag.value)]);
}

function writeCompound(compound: NbtCompound): Buffer {
  const entries: Buffer[] = [];
  for (const [name, tag] of compound.entries()) {
    entries.push(writeNamedTag(name, tag));
  }
  entries.push(Buffer.from([TAG.End]));
  return Buffer.concat(entries);
}

export function parseLittleEndianNbt(buffer: Buffer): { rootName: string; root: NbtCompound } {
  return new Reader(buffer).readRoot();
}

export function writeLittleEndianNbt({ rootName = "", root }: { rootName?: string; root: NbtCompound }): Buffer {
  return Buffer.concat([Buffer.from([TAG.Compound]), writeString(rootName), writeCompound(root)]);
}

export function getTag(compound: NbtCompound, name: string): NbtTag | undefined {
  return compound.get(name);
}

export function getCompoundValue(compound: NbtCompound, name: string): NbtCompound | undefined {
  const tag = getTag(compound, name);
  return tag?.type === TAG.Compound && tag.value instanceof Map ? tag.value : undefined;
}

export function getListValue(compound: NbtCompound, name: string): NbtList | undefined {
  const tag = getTag(compound, name);
  if (tag?.type !== TAG.List || typeof tag.value !== "object" || tag.value === null || !("values" in tag.value)) {
    return undefined;
  }

  return tag.value as NbtList;
}

export function getStringValue(compound: NbtCompound, name: string): string {
  const tag = getTag(compound, name);
  return tag?.type === TAG.String ? String(tag.value) : "";
}

export function getNumberValue(compound: NbtCompound, name: string, fallback = 0): number {
  const tag = getTag(compound, name);
  if (!tag) {
    return fallback;
  }

  if (typeof tag.value === "number") {
    return tag.value;
  }

  if (typeof tag.value === "bigint") {
    return Number(tag.value);
  }

  return fallback;
}

export function setTag(compound: NbtCompound, name: string, type: TagType, value: NbtValue): void {
  compound.set(name, { type, value });
}
