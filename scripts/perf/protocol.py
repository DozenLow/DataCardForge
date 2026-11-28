"""Deterministic fixtures and real loopback protocol probes; no third-party deps."""

import array
import functools
import hashlib
import http.client
import json
import math
import socket
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path


MAX_BODY = 32 * 1024 * 1024
MAGIC = 0x44434D32
MASK = 1009


def compact(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode()


def ms():
    return time.perf_counter_ns() / 1e6


def value(row, col, missing=False):
    if missing and (row + 13 * col) % 97 == 13:
        return math.nan
    return ((row * (2 * col + 1) + 17 * col + 3) % MASK - 504) / 8


def mean(rows, col, missing=False):
    period = MASK * (97 if missing else 1)
    terms = [v for r in range(min(rows, period)) if not math.isnan(v := value(r, col, missing))]
    if rows <= period:
        return math.fsum(terms) / len(terms) if terms else math.nan
    cycles, tail = divmod(rows, period)
    rest = [v for r in range(tail) if not math.isnan(v := value(r, col, missing))]
    return (cycles * math.fsum(terms) + math.fsum(rest)) / (cycles * len(terms) + len(rest))


def names(cols):
    return [f'c{c}' for c in range(cols)]


def csv_fixture(path, rows, cols, missing=False):
    path = Path(path)
    sha = hashlib.sha256()
    count = 0
    # For dense fixtures the whole row sequence repeats. Never buffer the whole file.
    templates = None if missing else [','.join(format(value(r, c), 'g') for c in range(cols)).encode()
                                      for r in range(min(MASK, rows))]
    with path.open('xb') as f:
        def line(data):
            nonlocal count
            chunk = data + b'\n'
            sha.update(chunk)
            count += f.write(chunk)
        line(','.join(names(cols)).encode())
        for r in range(rows):
            line(templates[r % MASK] if templates else ','.join(
                'NA' if math.isnan(v := value(r, c, missing)) else format(v, 'g')
                for c in range(cols)).encode())
    return {'path': path.name, 'rows': rows, 'cols': cols, 'missing': missing,
            'fixture_bytes': count, 'sha256': sha.hexdigest()}


def labels(cols):
    return [f'Pos.{c + 1} c{c}' for c in range(cols)]


def raw_size(rows, cols):
    return 24 + rows * cols * 8 + len(compact(labels(cols)))


def raw_payload(rows, cols, missing=False):
    trailer = compact(labels(cols))
    out = bytearray(struct.pack('<6I', MAGIC, rows, cols, len(trailer), rows, cols))
    for c in range(cols):
        if missing:
            data = array.array('d', (value(r, c, True) for r in range(rows)))
        else:
            table = array.array('d', (value(r, c) for r in range(min(MASK, rows))))
            cycles, tail = divmod(rows, len(table))
            data = table * cycles + table[:tail]
        if sys.byteorder != 'little':
            data.byteswap()
        out.extend(data.tobytes())
    return out + trailer


def json_payload(rows, cols, missing=False):
    """Use compact JS-compatible decimal spellings (values are exact eighths)."""
    chunks = [b'{"label":"perf","columns":[']
    for c in range(cols):
        if c:
            chunks.append(b',')
        chunks.append(f'{{"posName":"Pos.{c+1}","annotation":"c{c}","data":['.encode())
        if missing:
            terms = ('"NaN"' if math.isnan(v := value(r, c, True)) else format(v, 'g') for r in range(rows))
            chunks.append(','.join(terms).encode())
        else:
            terms = [format(value(r, c), 'g') for r in range(min(MASK, rows))]
            cycles, tail = divmod(rows, len(terms))
            if cycles:
                cycle = ','.join(terms).encode()
                chunks.append((cycle + b',') * (cycles - 1) + cycle)
            if tail:
                if cycles:
                    chunks.append(b',')
                chunks.append(','.join(terms[:tail]).encode())
        chunks.append(b']}')
    chunks.append(b']}')
    return b''.join(chunks)


class ProbeError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def require(condition, detail):
    if not condition:
        raise ProbeError('wrong_result', detail)


@dataclass
class Frame:
    rows: int
    cols: int
    full_rows: int
    full_cols: int
    names: list
    data: bytes

    def at(self, r, c):
        return struct.unpack_from('<d', self.data, 24 + 8 * (c * self.rows + r))[0]


def decode(payload):
    require(len(payload) >= 24, 'short DCM2 header')
    magic, rows, cols, name_len, full_rows, full_cols = struct.unpack_from('<6I', payload)
    offset = 24 + 8 * rows * cols
    require(magic == MAGIC and offset + name_len == len(payload) and rows <= full_rows and cols <= full_cols,
            'invalid DCM2 magic, shape, or length')
    try:
        names_ = json.loads(payload[offset:])
    except (ValueError, UnicodeError) as e:
        raise ProbeError('wrong_result', f'invalid DCM2 names: {e}') from e
    require(isinstance(names_, list) and len(names_) == cols, 'DCM2 names do not match width')
    return Frame(rows, cols, full_rows, full_cols, names_, payload)


def check_frame(frame, rows, cols, start, count, oracle):
    require((frame.full_rows, frame.full_cols, frame.rows, frame.cols) == (rows, cols, count, cols),
            f'window/total shape mismatch: {frame.rows}×{frame.cols} of {frame.full_rows}×{frame.full_cols}')
    # Small windows are checked in full; large ones check both corners and an interior sample.
    samples = ((r, c) for r in range(count) for c in range(cols)) if count * cols <= 1000 else (
        (r, c) for r in {0, count // 2, count - 1} for c in {0, cols // 2, cols - 1})
    for r, c in samples:
        got, want = frame.at(r, c), oracle(start + r, c)
        require((math.isnan(got) and math.isnan(want)) or math.isclose(got, want, abs_tol=1e-10, rel_tol=1e-12),
                f'wrong cell ({start+r}, {c}): {got} != {want}')


class Client:
    def __init__(self, port, timeout=60):
        self.deadline = time.monotonic() + timeout
        self.conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        self.request_bytes = self.response_bytes = self.requests = 0

    def close(self):
        self.conn.close()

    def counts(self):
        return {key: getattr(self, key) for key in ('request_bytes', 'response_bytes', 'requests')}

    def request(self, method, path, body=None, raw=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError('timeout', f'API deadline before {method} {path}')
        self.conn.timeout = remaining
        if self.conn.sock is not None:
            self.conn.sock.settimeout(remaining)
        headers = {}
        if body is not None:
            if not isinstance(body, (bytes, bytearray)):
                body = compact(body)
            headers['Content-Type'] = 'application/octet-stream' if raw else 'application/json'
        self.requests += 1
        try:
            if body is not None and len(body) > MAX_BODY:
                # The server decides from Content-Length before reading the body. Wait for
                # its rejection instead of racing a TCP reset by writing unread bytes.
                self.conn.putrequest(method, '/api' + path)
                self.conn.putheader('Content-Length', str(len(body)))
                for name, val in headers.items():
                    self.conn.putheader(name, val)
                self.conn.endheaders()
            else:
                self.request_bytes += len(body or b'')
                self.conn.request(method, '/api' + path, body, headers)
            result = self.conn.getresponse()
            payload = result.read()
        except (socket.timeout, TimeoutError) as e:
            raise ProbeError('timeout', f'{method} {path}: {e}') from e
        except (OSError, http.client.HTTPException) as e:
            raise ProbeError('transport_error', f'{method} {path}: {e}') from e
        self.response_bytes += len(payload)
        if result.status != 200:
            if result.status == 413:
                self.conn.close()  # The server drops this connection after a framing rejection.
            status = 'payload_cap' if result.status == 413 else 'http_error'
            raise ProbeError(status, f'{method} {path}: HTTP {result.status} {payload[:220]!r}')
        return payload if raw and method == 'GET' else json.loads(payload)


def upload(client, payload, kind):
    return client.request('POST', '/matrices/raw' if kind == 'raw' else '/matrices', payload,
                          raw=kind == 'raw')['matrixId']


def matrix_window(client, matrix, start, count):
    return decode(client.request('GET', f'/matrices/{matrix}/window?start={start}&count={count}', raw=True))


def formula(client, *, source, node_source=False, scale=2, offset=1):
    key = 'sourceNodeId' if node_source else 'sourceMatrixId'
    bindings = [{'portId': 'src', 'varName': 'src', 'mode': 'matrix', key: source}]
    symbol = 'result' if node_source else 'c0'
    result = client.request('POST', '/nodes', {'inputs': bindings,
                            'signatureId': 'builtin:expression-columns',
                            'params': {'formulas': [{'name': 'result', 'expression': f'{symbol}*{scale}+{offset}'}]}})
    if result.get('state') != 'done' or len(result.get('resultMatrixIds', [])) != 1:
        details = client.request('GET', f"/nodes/{result['nodeId']}")
        raise ProbeError('wrong_result', f'formula creation did not finish: {details}')
    return result


def timed(emit, phase, client, action):
    before = client.counts()
    start = ms()
    try:
        result, check = action()
        end = ms()
        check()  # Validation gates the sample but is outside the measured interval.
    except ProbeError as e:
        emit(phase, e.status, detail=str(e), **{k: v - before[k] for k, v in client.counts().items()})
        raise
    emit(phase, 'ok', elapsed_ms=end-start, **{k: v - before[k] for k, v in client.counts().items()})
    return result


def api_sequence(client, payload, kind, rows, cols, missing, emit):
    matrix = timed(emit, 'register', client, lambda: (upload(client, payload, kind), lambda: None))
    count = min(rows, 100)
    oracle = functools.partial(value, missing=missing)
    def first_window():
        frame = matrix_window(client, matrix, 0, count)
        return frame, lambda: check_frame(frame, rows, cols, 0, count, oracle)

    timed(emit, 'first_window', client, first_window)
    check_frame(matrix_window(client, matrix, rows-1, 1), rows, cols, rows-1, 1, oracle)
    start = ms()
    before = client.counts()
    created = formula(client, source=matrix)
    result = created['resultMatrixIds'][0]
    checked = matrix_window(client, result, 0, count)
    end = ms()
    after = client.counts()
    transformed = lambda r, c: oracle(r, 0) * 2 + 1
    check_frame(checked, rows, 1, 0, count, transformed)
    check_frame(matrix_window(client, result, rows-1, 1), rows, 1, rows-1, 1, transformed)
    # Audit the entire derived column only for small fixtures, then check an independent aggregate.
    if rows <= 500:
        check_frame(matrix_window(client, result, 0, rows), rows, 1, 0, rows, transformed)
    emit('formula_readable', 'ok', elapsed_ms=end-start, result_rows=rows,
         **{k: v - before[k] for k, v in after.items()})
    stats = client.request('POST', '/nodes', {'inputs': [{'portId': 'src', 'varName': 'src',
                           'mode': 'matrix', 'sourceMatrixId': matrix}], 'signatureId': 'builtin:summary',
                           'params': {'stats': ['mean']}})
    require(stats.get('state') != 'done', 'explicit summary computed during creation')
    start = ms()
    before = client.counts()
    computed = client.request('POST', f"/nodes/{stats['nodeId']}/compute")
    require(computed.get('state') == 'done', f'explicit summary unsuccessful: {computed}')
    frame = matrix_window(client, stats['resultMatrixIds'][0], 0, 1)
    end = ms()
    for c in range(cols):
        check_frame_column(frame, cols, c, mean(rows, c, missing))
    emit('summary_readable', 'ok', elapsed_ms=end-start, result_rows=1,
         **{k: v - before[k] for k, v in client.counts().items()})
    return matrix


def check_frame_column(frame, cols, col, expected):
    require((frame.full_rows, frame.full_cols, frame.rows, frame.cols) == (1, cols, 1, cols), 'summary shape mismatch')
    require(math.isclose(frame.at(0, col), expected, abs_tol=1e-10, rel_tol=1e-12), f'summary mean mismatch: c{col}')


def wave(client, events, payload, rows, cols, width, depth, emit):
    matrix = upload(client, payload, 'raw')
    results = []
    for _ in range(width):
        source = matrix
        for level in range(depth):
            node = formula(client, source=source, node_source=bool(level), scale=1, offset=1)
            source = node['nodeId']
            results.append((node, level + 1))
    backlog = events.request('GET', '/events?since=0&timeout=1')
    cursor = max((e['seq'] for e in backlog), default=0)
    # Event stream is independent of the mutation request (whose route can wait for recomputation).
    from concurrent.futures import ThreadPoolExecutor
    pending = {node['nodeId'] for node, _ in results}
    changed = value(0, 0) + 100

    def wait_done():
        nonlocal cursor
        first = None
        while pending:
            batch = events.request('GET', f'/events?since={cursor}&timeout=1')
            stamp = ms()
            for e in batch:
                cursor = max(cursor, e['seq'])
                if e.get('nodeId') in pending:
                    require(e.get('state') != 'error', f'wave node error: {e}')
                    if e.get('state') == 'done':
                        pending.remove(e['nodeId'])
                        if first is None:
                            first = stamp
        return first, stamp

    before, events_before = client.counts(), events.counts()
    with ThreadPoolExecutor(max_workers=1) as pool:
        start = ms()
        observer = pool.submit(wait_done)
        patched = client.request('PATCH', f'/matrices/{matrix}', {'cells': [{'row': 0, 'col': 0, 'value': changed}]})
        patch_end = ms()
        after = client.counts()
        first, last = observer.result()
    require(patched.get('revision', 0) > 0, 'matrix revision did not advance')
    round_bytes = {k: v - before[k] + events.counts()[k] - events_before[k] for k, v in client.counts().items()}
    for node, level in results:
        result = node['resultMatrixIds'][0]
        oracle = lambda r, c: (changed if r == 0 else value(r, 0)) + level
        check_frame(matrix_window(client, result, 0, 1), rows, 1, 0, 1, oracle)
        check_frame(matrix_window(client, result, rows-1, 1), rows, 1, rows-1, 1, oracle)
    emit('patch_ack', 'ok', elapsed_ms=patch_end-start,
         **{k: v - before[k] for k, v in after.items()})
    emit('wave_first_done', 'ok', elapsed_ms=first-start)
    emit('wave_last_done', 'ok', elapsed_ms=last-start, cards_per_s=len(results)*1000/(last-start), **round_bytes)
    return matrix
