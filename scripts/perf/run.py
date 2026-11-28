#!/usr/bin/env python3
"""Opt-in DataCardForge performance matrix. Linux; never connects to the daily instance."""

import argparse
import concurrent.futures
import contextlib
import csv
import hashlib
import itertools
import json
import os
import platform
import signal
import shutil
import socket
import subprocess as sp
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
from protocol import (MAX_BODY, Client, ProbeError, api_sequence, check_frame, csv_fixture, json_payload,
                      matrix_window, ms, raw_payload, raw_size, require, upload, value, wave)

ROOT = Path(__file__).resolve().parents[2]
SCALE = [(r, 20) for r in (10000, 50000, 100000, 200000, 500000, 1000000)] + [
    (100000, c) for c in (6, 50, 100, 200)]
FIELDS = ('suite case phase status i warmup rows cols cells width depth lanes missing body_bytes elapsed_ms '
          'request_bytes response_bytes requests result_rows displayed_rows points_in points_out cards_per_s '
          'frame_gap_p50_ms frame_gap_p95_ms frame_gap_max_ms frames start_ms end_ms '
          'backend_peak_rss_bytes backend_steady_rss_bytes browser_tree_peak_sampled_bytes '
          'browser_tree_steady_sampled_bytes backend_exit_code memory_limit_bytes cgroup_peak_bytes '
          'cgroup_steady_bytes cgroup_oom cgroup_oom_kill retained_tables recovery detail').split()


def clean_env(**extra):
    # Don't accidentally inherit a non-default gate, capability, or lane override.
    return {**{k: v for k, v in os.environ.items() if not k.startswith('DC_')}, **extra}


def command(*args):
    return sp.check_output(args, cwd=ROOT, text=True, stderr=sp.DEVNULL).strip()


def proc_status(pid, key):
    try:
        for line in Path(f'/proc/{pid}/status').read_text().splitlines():
            if line.startswith(key + ':'):
                return int(line.split()[1]) * 1024
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
    return None


def tree_rss(pid):
    total, todo, seen = 0, [pid], set()
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        total += proc_status(p, 'VmRSS') or 0
        # Chromium helpers can be born from non-leader threads.
        for task in Path(f'/proc/{p}/task').glob('*'):
            try:
                todo.extend(int(x) for x in (task / 'children').read_text().split())
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
    return total


def stop(p):
    if p.poll() is not None:
        return
    # Only for a benchmark process that this driver launched in a new session.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(p.pid, signal.SIGTERM)
    try:
        p.wait(2)
    except sp.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, signal.SIGKILL)
        p.wait()


class Cgroup:
    def __init__(self, base, tier):
        self.path = None
        self.limit = tier * 1024**3
        if not base:
            raise ProbeError('blocked', 'no --cgroup-parent supplied; host cgroup root not writable in this session')
        base = base.resolve(strict=True)
        if not base.is_relative_to(Path('/sys/fs/cgroup')):
            raise ValueError('cgroup parent must be within /sys/fs/cgroup')
        self.path = Path(tempfile.mkdtemp(prefix='dc-perf-', dir=base))
        try:
            for name, val in [('memory.max', self.limit), ('memory.swap.max', 0), ('memory.oom.group', 1)]:
                (self.path / name).write_text(str(val))
            for name in ('memory.max', 'memory.swap.max', 'memory.oom.group', 'memory.peak', 'memory.events'):
                (self.path / name).read_text()
            if (self.read('memory.max'), self.read('memory.swap.max'), self.read('memory.oom.group')) != (self.limit, 0, 1):
                raise ProbeError('blocked', 'cgroup memory/swap/group configuration not applied')
        except BaseException:
            self.close()
            raise

    def wrap(self, args):
        return ['sh', '-c', 'echo $$ > "$1/cgroup.procs" || exit 125; shift; exec "$@"', 'cg', str(self.path), *args]

    def read(self, name):
        return int((self.path / name).read_text())

    def info(self):
        e = dict(line.split() for line in (self.path / 'memory.events').read_text().splitlines())
        return {'memory_limit_bytes': self.limit, 'cgroup_peak_bytes': self.read('memory.peak'),
                'cgroup_oom': int(e.get('oom', 0)), 'cgroup_oom_kill': int(e.get('oom_kill', 0))}

    def close(self):
        if self.path is not None:
            self.path.rmdir()


@dataclass
class Server:
    port: int
    process: sp.Popen
    hello: dict
    start_ms: float

    def memory(self):
        return proc_status(self.process.pid, 'VmHWM')


@contextlib.contextmanager
def server(args, sha, out, index, lanes=8, group=None):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        if port in (37811, 5173):
            raise RuntimeError('refusing to use a daily service port')
    with tempfile.TemporaryDirectory(prefix='server-', dir=out) as sandbox:
        cmd = [str(args.backend), '--port', str(port), '--web-root', str(args.web_root), '--no-open']
        if group:
            cmd = group.wrap(cmd)
        with (out / 'backend.log').open('ab', buffering=0) as log:
            log.write(f'\n=== attempt {index} 127.0.0.1:{port} ===\n'.encode())
            start = ms()
            p = sp.Popen(cmd, cwd=sandbox, stdout=log, stderr=sp.STDOUT, start_new_session=True,
                         env=clean_env(DC_TRUST_DIR=sandbox, DC_FORMULA_LANE=str(lanes), DC_SCRIPT_LANE='4'))
            try:
                until = time.monotonic() + min(args.timeout, 10)
                while True:
                    if p.poll() is not None:
                        raise ProbeError('process_exit', f'dc_backend exited {p.returncode}; see backend.log')
                    if time.monotonic() >= until:
                        raise ProbeError('timeout', 'backend hello did not arrive')
                    client = Client(port, 0.3)
                    try:
                        hello = client.request('GET', '/hello')
                    except ProbeError:
                        time.sleep(.01)
                        continue
                    finally:
                        client.close()
                    ready = ms()
                    # Reject any port collision, even with a same-SHA server.
                    if not owns_listener(p.pid, port):
                        raise ProbeError('blocked', f'port {port} is not served by benchmark PID {p.pid}')
                    if hello.get('build') != sha:
                        raise ProbeError('wrong_build', f'expected {sha}, got {hello.get("build")}')
                    yield Server(port, p, hello, ready-start)
                    break
            finally:
                stop(p)


def owns_listener(pid, port):
    endpoint = f'0100007F:{port:04X}'
    inode = set()
    for line in Path(f'/proc/{pid}/net/tcp').read_text().splitlines()[1:]:
        cols = line.split()
        if cols[1] == endpoint and cols[3] == '0A':
            inode.add(f'socket:[{cols[9]}]')
    for item in Path(f'/proc/{pid}/fd').iterdir():
        with contextlib.suppress(FileNotFoundError):
            if os.readlink(item) in inode:
                return True
    return False


def child_group(cmd, cwd, out, timeout, env=None, track=False, group=None, backend_pid=None):
    """Run one bounded child; capture JSONL, sample only the owned browser tree."""
    if group:
        cmd = group.wrap(cmd)
    with (out / 'runner.log').open('ab', buffering=0) as log:
        p = sp.Popen(cmd, cwd=cwd, stdin=sp.PIPE if track else sp.DEVNULL, stdout=sp.PIPE, stderr=log,
                     env=env, text=True, start_new_session=True)
        peak, steady = 0, (None, None)
        done = threading.Event()
        collected = []
        def monitor():
            nonlocal peak
            while not done.is_set():
                peak = max(peak, tree_rss(p.pid))
                done.wait(.05)

        def read_line():
            nonlocal steady
            for line in p.stdout:
                collected.append(line)
                if track and '"steady"' in line:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if rec.get('phase') == 'steady' and rec.get('status') == 'ok' and not p.stdin.closed:
                        steady = (tree_rss(p.pid), proc_status(backend_pid, 'VmRSS') if backend_pid else None)
                        # The tab holds still until this acknowledgement or its hold timeout.
                        with contextlib.suppress(BrokenPipeError):
                            p.stdin.write('\n')
                            p.stdin.flush()
                            p.stdin.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            reader = pool.submit(read_line)
            watcher = pool.submit(monitor) if track else None
            try:
                p.wait(timeout)
            except sp.TimeoutExpired:
                stop(p)
                return p.returncode, collected, peak, steady, True
            finally:
                done.set()
                reader.result()
                if watcher:
                    watcher.result()
                p.stdout.close()
                if p.stdin:
                    with contextlib.suppress(BrokenPipeError):
                        p.stdin.close()
    return p.returncode, collected, peak, steady, False


def json_lines(lines):
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError as e:
            raise ProbeError('harness_error', f'invalid child JSONL: {line[:160]}') from e
        require(isinstance(record, dict) and 'status' in record, 'missing child record status')
        yield record


class Experiment:
    def __init__(self, args):
        self.args = args
        self.out = args.out
        self.out.mkdir(parents=True, exist_ok=False)
        self.file = (self.out / 'samples.csv').open('x', newline='', encoding='utf-8')
        self.writer = csv.DictWriter(self.file, fieldnames=FIELDS)
        self.writer.writeheader()
        self.sha = command('git', 'rev-parse', '--short', 'HEAD')
        self.index = 0
        self.fixtures = {}
        self.manifest = self.environment()
        self.save_manifest()

    def environment(self):
        a = self.args
        cpu = next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines()
                    if line.startswith('model name')), platform.processor())
        avail = sorted(os.sched_getaffinity(0))
        cfg = {}
        cache = a.backend.parent / 'CMakeCache.txt'
        if cache.exists():
            cfg = dict(line.split('=', 1) for line in cache.read_text().splitlines()
                       if line.startswith(('CMAKE_BUILD_TYPE:', 'CMAKE_CXX_COMPILER:', 'Eigen3_DIR:')))
        artifact = {}
        for key in ('backend', 'engine', 'web_root'):
            path = getattr(a, key)
            if key == 'web_root' and path.is_dir():
                digest = hashlib.sha256()
                files = sorted(p for p in path.rglob('*') if p.is_file())
                for file in files:
                    with file.open('rb') as f:
                        digest.update(file.relative_to(path).as_posix().encode() + b'\0' + hashlib.file_digest(f, 'sha256').digest())
                artifact[key] = {'path': str(path), 'sha256_tree': digest.hexdigest(), 'files': len(files)}
            elif path.is_file():
                with path.open('rb') as f:
                    artifact[key] = {'path': str(path), 'sha256': hashlib.file_digest(f, 'sha256').hexdigest()}
        return {'started_utc': datetime.now(timezone.utc).isoformat(), 'git_sha': command('git', 'rev-parse', 'HEAD'),
                'git_status': command('git', 'status', '--short').splitlines(), 'expected_hello_build': self.sha,
                'os': platform.platform(), 'cpu': cpu, 'allowed_cpus': avail, 'loadavg_at_start': os.getloadavg(),
                'memory': Path('/proc/meminfo').read_text().splitlines()[:3], 'build': cfg, 'artifacts': artifact,
                'harness_sha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in (Path(__file__).resolve(), ROOT/'scripts/perf/protocol.py',
                                             ROOT/'web/scripts/perf-browser.mjs')},
                'node': command('node', '--version') if shutil.which('node') else None,
                'browser_versions': [], 'hello': None, 'fixture_version': 'period1009-v1',
                'fixtures': {}, 'api_payloads': {}, 'formula_lanes_default': 8, 'script_lanes': 4,
                'uploads_max_body_bytes': MAX_BODY, 'protocol_bytes': 'HTTP body bytes, excluding headers; oversize API test sends headers only',
                'memory_scope': 'server VmHWM/VmRSS; browser child-tree sampled RSS sum (shared pages may be counted twice); cgroup tracked separately',
                'cache_policy': 'fresh server per API/browser attempt; no OS cache flush; see mode for browser policy',
                'args': {k: str(v) if isinstance(v, Path) else v for k, v in vars(a).items()}, 'complete': False}

    def save_manifest(self):
        temp = self.out / 'manifest.tmp'
        temp.write_text(json.dumps(self.manifest, indent=2, ensure_ascii=False) + '\n')
        temp.replace(self.out / 'manifest.json')

    def write(self, **record):
        unknown = set(record) - set(FIELDS)
        if unknown:
            raise ProbeError('harness_error', f'unknown sample fields: {sorted(unknown)}')
        self.writer.writerow(record)
        self.file.flush()

    def point(self, suite, case, rows=0, cols=0, *, high=False, **dims):
        return Point(self, {'suite': suite, 'case': case, 'rows': rows, 'cols': cols,
                            'cells': rows*cols, **dims}, self.args.exploratory if high else self.args.samples)

    def api_payload(self, kind, rows, cols, missing):
        body = (raw_payload if kind == 'raw' else json_payload)(rows, cols, missing)
        self.manifest['api_payloads'][f'{kind}-{rows}x{cols}' + ('-missing' if missing else '')] = {
            'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        return body

    def fixture(self, rows, cols, missing=False):
        key = f'{rows}x{cols}' + ('-missing' if missing else '')
        path = self.out / 'fixtures' / f'{key}.csv'
        if key not in self.fixtures:
            path.parent.mkdir(exist_ok=True)
            self.manifest['fixtures'][key] = csv_fixture(path, rows, cols, missing)
            self.fixtures[key] = path
        return path

    def boot(self, point, attempt, group=None):
        self.index += 1
        return server(self.args, self.sha, self.out, self.index, point.base.get('lanes', 8), group)

    def read_hello(self, s):
        if self.manifest['hello'] is None:
            self.manifest['hello'] = s.hello


class Point:
    def __init__(self, experiment, base, samples):
        self.exp, self.base, self.samples = experiment, base, samples
        self.args = experiment.args
        print(f"{base['suite']}/{base['case']} {base['rows']}×{base['cols']} {samples} attempts", flush=True)

    def indices(self):
        return itertools.chain(range(-self.args.warmup, 0), range(1, self.samples+1))

    def emit(self, i, phase, status, **fields):
        self.exp.write(**{**self.base, 'i': i, 'warmup': int(i < 0), 'phase': phase, 'status': status, **fields})

    def fail(self, i, e, *, phase='attempt'):
        self.emit(i, phase, getattr(e, 'status', 'harness_error'), detail=str(e))


def api_point(exp, kind, rows, cols, *, missing=False, boundary=False):
    point = exp.point('boundary' if boundary else 'api', kind, rows, cols,
                      high=boundary or rows*cols > 2000000 or missing, missing=int(missing))
    body = exp.api_payload(kind, rows, cols, missing)
    point.base['body_bytes'] = len(body)
    for i in point.indices():
        try:
            with exp.boot(point, i) as s:
                exp.read_hello(s)
                client = Client(s.port, exp.args.timeout)
                emit = lambda *a, **kw: point.emit(i, *a, **kw)
                try:
                    api_sequence(client, body, kind, rows, cols, missing, emit)
                    require(len(body) <= MAX_BODY, 'over-limit upload unexpectedly accepted')
                except ProbeError as e:
                    if e.status != 'payload_cap' or len(body) <= MAX_BODY:
                        raise
                    # Prove this is request rejection, not process failure; no restart here.
                    tiny = raw_payload(2, 1)
                    small = upload(client, tiny, 'raw')
                    check_frame(matrix_window(client, small, 0, 2), 2, 1, 0, 2, value)
                    emit('recovery', 'ok', recovery=1)
                finally:
                    client.close()
                    point.emit(i, 'memory', 'ok' if s.process.poll() is None else 'process_exit',
                               backend_peak_rss_bytes=s.memory(), backend_exit_code=s.process.poll())
        except (ProbeError, OSError, ValueError, KeyError) as e:
            point.fail(i, e)


def wave_point(exp, rows, cols, width, depth, lanes):
    point = exp.point('wave', 'depth' if depth > 1 else 'width', rows, cols,
                      high=width >= 16 or depth >= 16, width=width, depth=depth, lanes=lanes)
    body = exp.api_payload('raw', rows, cols, False)
    for i in point.indices():
        try:
            with exp.boot(point, i) as s:
                exp.read_hello(s)
                setup_timeout = exp.args.timeout
                c, events = Client(s.port, setup_timeout), Client(s.port, setup_timeout)
                try:
                    wave(c, events, body, rows, cols, width, depth, lambda *a, **kw: point.emit(i, *a, **kw))
                finally:
                    c.close()
                    events.close()
                    point.emit(i, 'memory', 'ok', backend_peak_rss_bytes=s.memory())
        except (ProbeError, OSError, ValueError, KeyError) as e:
            point.fail(i, e)


def browser_point(exp, mode, rows, cols, *, missing=False, memory=False):
    a = exp.args
    point = exp.point('browser', mode + ('_steady' if memory else ''), rows, cols,
                      high=memory or missing or rows*cols > 2000000, missing=int(missing))
    fixture = exp.fixture(rows, cols, missing)
    for i in point.indices():
        try:
            with exp.boot(point, i) as s:
                exp.read_hello(s)
                if mode == 'cold':
                    point.emit(i, 'backend_start_to_hello', 'ok', elapsed_ms=s.start_ms)
                with tempfile.TemporaryDirectory(prefix='browser-', dir=exp.out) as temp:
                    args = ['node', str(ROOT / 'web/scripts/perf-browser.mjs'), '--url', f'http://127.0.0.1:{s.port}',
                            '--file', str(fixture), '--rows', str(rows), '--cols', str(cols), '--samples', '1',
                            '--warmup', '0', '--timeout-ms', str(a.timeout * 1000), '--mode', mode]
                    env = clean_env(TMPDIR=temp)
                    if missing:
                        args += ['--missing']
                    if memory:
                        args += ['--steady-ms', '5000']
                    ended, lines, peak, steady, timed_out = child_group(args, ROOT, exp.out,
                                               a.timeout + (10 if memory else 5), env=env, track=True,
                                               backend_pid=s.process.pid)
                statuses = []
                for rec in json_lines(lines):
                    rec.pop('i', None)
                    phase = rec.pop('phase')
                    status = rec.pop('status')
                    if phase in ('metadata', 'meta'):
                        version = rec.get('browser_version') or rec.get('version') or rec.get('detail')
                        if version and version not in exp.manifest['browser_versions']:
                            exp.manifest['browser_versions'].append(version)
                        continue
                    detail = rec.get('detail', '')
                    if timed_out and status == 'browser_crash' and (
                            'has been closed' in detail or 'Target closed' in detail):
                        status = 'timeout'
                        rec['detail'] = 'attempt deadline; browser closure observed: ' + detail
                    statuses.append(status)
                    point.emit(i, phase, status, **rec)
                live = s.process.poll()
                point.emit(i, 'memory', 'ok' if live is None else 'process_exit', backend_peak_rss_bytes=s.memory(),
                           backend_exit_code=live, backend_steady_rss_bytes=steady[1],
                           browser_tree_peak_sampled_bytes=peak or None, browser_tree_steady_sampled_bytes=steady[0])
                if timed_out or not statuses or (ended and all(status == 'ok' for status in statuses)):
                    raise ProbeError('timeout' if timed_out else 'process_exit', f'browser runner exit={ended}; see runner.log')
        except (ProbeError, OSError, ValueError, KeyError) as e:
            point.fail(i, e)


def engine_point(exp, case, rows, cols):
    point = exp.point('engine', case, rows, cols, high=case in ('matmul', 'solve') and rows >= 512 or rows*cols > 2000000)
    a = exp.args
    for i in range(-a.warmup, 0):
        # Each runner performs warm-ups with initialized operands in the same process, not in fresh processes.
        point.emit(i, 'compute', 'internal_warmup')
    args = [str(a.engine), '--case', case, '--rows', str(rows), '--cols', str(cols), '--samples',
            str(point.samples), '--warmup', str(a.warmup)]
    try:
        ended, lines, _, _, timed_out = child_group(args, ROOT, exp.out, a.timeout, env=clean_env())
        seen = set()
        for rec in json_lines(lines):
            i = rec.pop('i')
            require(isinstance(i, int) and 1 <= i <= point.samples and i not in seen, 'invalid engine sample index')
            seen.add(i)
            point.emit(i, 'compute', rec.pop('status'), **rec)
        for i in set(range(1, point.samples + 1)) - seen:
            point.emit(i, 'compute', 'timeout' if timed_out else 'process_exit', detail=f'engine exit={ended}; see runner.log')
    except (ProbeError, OSError, ValueError, KeyError) as e:
        point.fail(0, e, phase='compute')


def capacity(exp):
    # Capacity is a separate, opt-in workload. Every uploaded table is below the request cap.
    a = exp.args
    if not a.cgroup_parent:
        for tier in (2, 4):
            exp.point('capacity', 'backend_retained', 200000, 20, high=True, memory_limit_bytes=tier*1024**3).emit(
                0, 'capacity', 'blocked', detail='no writable delegated cgroup v2 memory parent provided')
            exp.point('capacity', 'full_stack', 0, 0, high=True, memory_limit_bytes=tier*1024**3).emit(
                0, 'capacity', 'blocked', detail='full-stack cgroup pressure not run without delegation')
        return
    rows, cols = 200000, 20
    body = exp.api_payload('raw', rows, cols, False)
    for tier in (2, 4):
        point = exp.point('capacity', 'backend_retained', rows, cols, high=True, memory_limit_bytes=tier*1024**3)
        for i in range(1, 6):
            cg = None
            try:
                cg = Cgroup(a.cgroup_parent, tier)
                with exp.boot(point, i, cg) as s:
                    exp.read_hello(s)
                    c = Client(s.port, min(a.capacity_timeout, 180))
                    retained = 0
                    start = ms()
                    status, detail = 'ok', ''
                    try:
                        # Every iteration adds a known resident table. By default stop close to the cap;
                        # --allow-cgroup-oom deliberately continues in this isolated backend-only group.
                        while cg.read('memory.current') < cg.limit * .94 or a.allow_cgroup_oom:
                            matrix = upload(c, body, 'raw')
                            check_frame(matrix_window(c, matrix, rows-1, 1), rows, cols, rows-1, 1, value)
                            retained += 1
                    except ProbeError as e:
                        status, detail = e.status, str(e)
                    finally:
                        c.close()
                    elapsed = ms()-start
                    recovery = 0
                    time.sleep(5)
                    steady = cg.read('memory.current')
                    if s.process.poll() is None:
                        c = Client(s.port, 10)
                        try:
                            m = upload(c, raw_payload(2, 1), 'raw')
                            check_frame(matrix_window(c, m, 0, 2), 2, 1, 0, 2, value)
                            recovery = 1
                        except ProbeError as e:
                            detail += f'; recovery: {e}'
                            if status == 'ok':
                                status = 'recovery_failed'
                        finally:
                            c.close()
                    info = cg.info()
                    exit_code = s.process.poll()
                    if info['cgroup_oom_kill'] > 0:
                        status = 'oom_kill'
                    elif info['cgroup_oom'] > 0:
                        status = 'oom_event'
                    elif exit_code is not None:
                        status = 'process_exit'
                    point.emit(i, 'capacity', status, elapsed_ms=elapsed, detail=detail, retained_tables=retained,
                               body_bytes=len(body), recovery=recovery, backend_exit_code=exit_code,
                               backend_peak_rss_bytes=s.memory(), cgroup_steady_bytes=steady, **info)
            except (OSError, ProbeError, ValueError) as e:
                point.emit(i, 'capacity', getattr(e, 'status', 'blocked'), detail=str(e))
                if cg is None:
                    for skipped in range(i+1, 6):
                        point.emit(skipped, 'capacity', 'blocked', detail=str(e))
                    break
            finally:
                if cg:
                    cg.close()
        exp.point('capacity', 'full_stack', 0, 0, high=True, memory_limit_bytes=tier*1024**3).emit(
            0, 'capacity', 'untested', detail='backend-only cgroup capacity workload; no full-stack stress claim')


def parse():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True, help='new output directory')
    p.add_argument('--backend', type=Path, required=True)
    p.add_argument('--engine', type=Path, required=True)
    p.add_argument('--web-root', type=Path, required=True)
    p.add_argument('--profile', choices=('smoke', 'matrix'), default='smoke')
    p.add_argument('--suite', nargs='+', choices=('api', 'boundary', 'wave', 'browser', 'engine', 'capacity'))
    p.add_argument('--browser-shape', nargs='+', metavar='ROWSxCOLS',
                   help='only selected matrix-profile browser shapes')
    p.add_argument('--browser-case', nargs='+', choices=('import', 'chart', 'import_steady', 'import_missing'),
                   help='restrict a focused browser shape run to specific cases')
    p.add_argument('--samples', type=int)
    p.add_argument('--warmup', type=int)
    p.add_argument('--exploratory', type=int, default=5)
    p.add_argument('--timeout', type=int, default=60)
    p.add_argument('--capacity-timeout', type=int, default=180)
    p.add_argument('--cgroup-parent', type=Path)
    p.add_argument('--allow-cgroup-oom', action='store_true', help='backend-only: approach actual OOM within a delegated memory cgroup')
    a = p.parse_args()
    if a.browser_shape and (a.suite != ['browser'] or a.profile != 'matrix' or
                            not set(a.browser_shape) <= {f'{r}x{c}' for r, c in SCALE}):
        p.error('--browser-shape requires --profile matrix --suite browser and known ROWSxCOLS shapes')
    if a.browser_case and not a.browser_shape:
        p.error('--browser-case requires --browser-shape')
    if a.samples is None:
        a.samples = 2 if a.profile == 'smoke' else 30
    if a.warmup is None:
        a.warmup = 0 if a.profile == 'smoke' else 3
    if not 1 <= a.samples <= 30 or not 1 <= a.exploratory <= 5 or not 0 <= a.warmup <= 3:
        p.error('samples must be 1..30, exploratory 1..5, warmup 0..3')
    if not (1 <= a.timeout <= 180 and 1 <= a.capacity_timeout <= 180):
        p.error('timeouts must be 1..180 seconds')
    if a.allow_cgroup_oom and (not a.cgroup_parent or 'capacity' not in (a.suite or [])):
        p.error('--allow-cgroup-oom requires explicit --suite capacity and --cgroup-parent')
    for key in ('out', 'backend', 'engine', 'web_root'):
        setattr(a, key, getattr(a, key).resolve())
    return a


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    args = parse()
    exp = Experiment(args)
    suites = args.suite or ['api', 'boundary', 'wave', 'browser', 'engine']
    dense = SCALE if args.profile == 'matrix' else [SCALE[0]]
    try:
        for suite in suites:
            if suite == 'api':
                for rows, cols in dense:
                    for kind in ('json', 'raw'):
                        api_point(exp, kind, rows, cols)
                if args.profile == 'matrix':
                    api_point(exp, 'json', 100000, 20, missing=True)
            elif suite == 'boundary':
                cols = 20
                raw_last = (MAX_BODY - raw_size(0, cols)) // (cols * 8)
                # Determine exact JSON body boundary with the real compact fixture representation.
                lo, hi = 1, 500000
                while hi - lo > 1:
                    mid = (lo + hi) // 2
                    if len(json_payload(mid, cols)) > MAX_BODY:
                        hi = mid
                    else:
                        lo = mid
                for kind, last in [('raw', raw_last), ('json', lo)]:
                    for r in (last, last+1):
                        api_point(exp, kind, r, cols, boundary=True)
            elif suite == 'wave':
                for width in ((1, 2, 4, 8, 16) if args.profile == 'matrix' else (1, 2)):
                    for lanes in ((8, 1) if args.profile == 'matrix' else (8,)):
                        wave_point(exp, 10000 if args.profile == 'smoke' else 100000, 6, width, 1, lanes)
                if args.profile == 'matrix':
                    for depth in (2, 4, 8, 16):
                        wave_point(exp, 100000, 6, 1, depth, 8)
            elif suite == 'browser':
                def selected(case, r, c):
                    return ((not args.browser_shape or f'{r}x{c}' in args.browser_shape) and
                            (not args.browser_case or case in args.browser_case))
                if not args.browser_shape:
                    browser_point(exp, 'cold', 10000, 20)
                for rows, cols in dense:
                    if selected('import', rows, cols):
                        browser_point(exp, 'import', rows, cols)
                for rows in ((10000, 100000, 1000000) if args.profile == 'matrix' else (10000,)):
                    if selected('chart', rows, 20):
                        browser_point(exp, 'chart', rows, 20)
                if args.profile == 'matrix':
                    for rows in (10000, 100000):
                        if selected('import_steady', rows, 20):
                            browser_point(exp, 'import', rows, 20, memory=True)
                    if selected('import_missing', 100000, 20):
                        browser_point(exp, 'import', 100000, 20, missing=True)
            elif suite == 'engine':
                for case in ('elem', 'reduce', 'quantile', 'window'):
                    for rows, cols in (dense if case == 'elem' else ((r, 1) for r, c in dense if c == 20)):
                        engine_point(exp, case, rows, cols)
                for case in ('matmul', 'solve'):
                    for size in ((128, 256, 512, 1024) if args.profile == 'matrix' else (128,)):
                        engine_point(exp, case, size, size)
            elif suite == 'capacity':
                capacity(exp)
            exp.save_manifest()
        exp.manifest['complete'] = True
    finally:
        exp.manifest['finished_utc'] = datetime.now(timezone.utc).isoformat()
        exp.save_manifest()
        exp.file.close()


if __name__ == '__main__':
    main()
