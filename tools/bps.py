#!/usr/bin/env python3
"""Minimal BPS patch creator and applier.

    bps.py create SOURCE TARGET PATCH
    bps.py apply  SOURCE PATCH TARGET

The encoder is tuned for rebuilt ROMs, where the target is mostly the source
with code inserted or removed, shifting everything after it.
"""

import sys
import zlib

SOURCE_READ, TARGET_READ, SOURCE_COPY, TARGET_COPY = range(4)
BLOCK = 32       # source is indexed every BLOCK bytes
MIN_MATCH = 48   # shortest match worth a copy command


def encode_number(n):
    out = bytearray()
    while True:
        x = n & 0x7F
        n >>= 7
        if n == 0:
            out.append(0x80 | x)
            return out
        out.append(x)
        n -= 1


def match_length(a, a_pos, b, b_pos, limit):
    """Length of the common prefix of a[a_pos:] and b[b_pos:], up to limit."""
    length = 0
    step = 4096
    while length < limit:
        n = min(step, limit - length)
        if a[a_pos + length:a_pos + length + n] == b[b_pos + length:b_pos + length + n]:
            length += n
            continue
        if n <= 16:
            while length < limit and a[a_pos + length] == b[b_pos + length]:
                length += 1
            return length
        step = max(16, n // 8)
    return length


def create(source, target):
    index = {}
    for i in range(0, len(source) - BLOCK + 1, BLOCK):
        index.setdefault(source[i:i + BLOCK], i)

    out = bytearray(b'BPS1')
    out += encode_number(len(source))
    out += encode_number(len(target))
    out += encode_number(0)

    source_rel = 0
    literal_start = 0
    delta = 0  # source offset - target offset of the previous copy

    def flush_literal(end):
        nonlocal literal_start
        if end > literal_start:
            out.extend(encode_number(((end - literal_start - 1) << 2) | TARGET_READ))
            out.extend(target[literal_start:end])
        literal_start = end

    def emit_copy(t, s, length):
        nonlocal source_rel
        if s == t:
            out.extend(encode_number(((length - 1) << 2) | SOURCE_READ))
        else:
            out.extend(encode_number(((length - 1) << 2) | SOURCE_COPY))
            offset = s - source_rel
            out.extend(encode_number((abs(offset) << 1) | (1 if offset < 0 else 0)))
            source_rel = s + length

    t = 0
    n = len(target)
    while t < n:
        best_s, best_len = -1, 0

        # Continuing the previous shift is the common case.
        s = t + delta
        if 0 <= s < len(source):
            best_len = match_length(target, t, source, s, min(n - t, len(source) - s))
            best_s = s

        if best_len < MIN_MATCH:
            # Look for this position's data anywhere in the source. A block
            # starting within BLOCK bytes of here is enough to anchor a match.
            for k in range(BLOCK):
                key = target[t + k:t + k + BLOCK]
                if len(key) < BLOCK:
                    break
                s = index.get(key)
                if s is None or s < k:
                    continue
                s -= k
                length = match_length(target, t, source, s, min(n - t, len(source) - s))
                if length > best_len:
                    best_s, best_len = s, length
                if length >= MIN_MATCH:
                    break

        if best_len < MIN_MATCH:
            t += 1
            continue

        # Extend the match backwards into pending literal bytes.
        while t > literal_start and best_s > 0 and target[t - 1] == source[best_s - 1]:
            t -= 1
            best_s -= 1
            best_len += 1

        flush_literal(t)
        emit_copy(t, best_s, best_len)
        delta = best_s - t
        t += best_len
        literal_start = t

    flush_literal(n)
    out += zlib.crc32(source).to_bytes(4, 'little')
    out += zlib.crc32(target).to_bytes(4, 'little')
    out += zlib.crc32(out).to_bytes(4, 'little')
    return bytes(out)


def apply(source, patch):
    if patch[:4] != b'BPS1':
        raise ValueError('not a BPS patch')
    if zlib.crc32(patch[:-4]) != int.from_bytes(patch[-4:], 'little'):
        raise ValueError('patch checksum mismatch')
    if zlib.crc32(source) != int.from_bytes(patch[-12:-8], 'little'):
        raise ValueError('source checksum mismatch')

    pos = 4

    def decode():
        nonlocal pos
        data, shift = 0, 1
        while True:
            x = patch[pos]
            pos += 1
            data += (x & 0x7F) * shift
            if x & 0x80:
                return data
            shift <<= 7
            data += shift

    decode()
    target = bytearray(decode())
    metadata_size = decode()
    pos += metadata_size
    out = source_rel = target_rel = 0
    end = len(patch) - 12
    while pos < end:
        data = decode()
        command, length = data & 3, (data >> 2) + 1
        if command == SOURCE_READ:
            target[out:out + length] = source[out:out + length]
        elif command == TARGET_READ:
            target[out:out + length] = patch[pos:pos + length]
            pos += length
        elif command == SOURCE_COPY:
            offset = decode()
            source_rel += -(offset >> 1) if offset & 1 else offset >> 1
            target[out:out + length] = source[source_rel:source_rel + length]
            source_rel += length
        else:
            offset = decode()
            target_rel += -(offset >> 1) if offset & 1 else offset >> 1
            for i in range(length):
                target[out + i] = target[target_rel + i]
            target_rel += length
        out += length

    if zlib.crc32(target) != int.from_bytes(patch[-8:-4], 'little'):
        raise ValueError('target checksum mismatch')
    return bytes(target)


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('create', 'apply'):
        sys.exit(__doc__)
    with open(sys.argv[2], 'rb') as f:
        first = f.read()
    with open(sys.argv[3], 'rb') as f:
        second = f.read()
    result = create(first, second) if sys.argv[1] == 'create' else apply(first, second)
    with open(sys.argv[4], 'wb') as f:
        f.write(result)


if __name__ == '__main__':
    main()
