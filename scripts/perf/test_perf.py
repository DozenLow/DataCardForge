"""Deterministic tests for the harness, not a speed budget."""

import csv
import hashlib
import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
from protocol import ProbeError, check_frame, csv_fixture, decode, json_payload, mean, raw_payload, raw_size, value
from report import DIMS, percentile, replace_points, summarize


@unittest.skipUnless(sys.platform == 'linux', 'the isolated benchmark driver requires Linux /proc')
class DriverTest(unittest.TestCase):
    def test_steady_handshake_acknowledges_and_closes_pipe(self):
        from run import child_group
        with tempfile.TemporaryDirectory() as d:
            child = (
                'import sys; '
                'print(\'{"phase":"steady","status":"ok"}\', flush=True); '
                'assert sys.stdin.read() == "\\n"; '
                'print("acknowledged")'
            )
            code, lines, _, _, expired = child_group(
                [sys.executable, '-c', child], d, Path(d), 10, track=True)
            self.assertFalse(expired)
            self.assertEqual(code, 0)
            self.assertEqual(lines[-1].strip(), 'acknowledged')


class ProtocolTest(unittest.TestCase):
    def test_transports_agree_on_fixture_shape_and_missing(self):
        rows, cols = 30, 3
        raw = raw_payload(rows, cols, True)
        self.assertEqual(len(raw), raw_size(rows, cols))
        frame = decode(raw)
        self.assertEqual(frame.names, ['Pos.1 c0', 'Pos.2 c1', 'Pos.3 c2'])
        check_frame(frame, rows, cols, 0, rows, lambda r, c: value(r, c, True))
        values = json.loads(json_payload(rows, cols, True))['columns']
        self.assertEqual(values[0]['data'][0], -62.625)
        self.assertEqual(values[0]['data'][13], 'NaN')
        self.assertTrue(math.isnan(frame.at(13, 0)))
        self.assertEqual(values[2]['data'][-1], -40.25)
        self.assertEqual(frame.at(29, 2), values[2]['data'][-1])

    def test_malformed_frame_or_wrong_numeric_result_is_not_success(self):
        data = raw_payload(2, 1)
        with self.assertRaises(ProbeError):
            decode(data[:-1])
        struct.pack_into('<d', data, 24, 123)
        with self.assertRaises(ProbeError):
            check_frame(decode(data), 2, 1, 0, 2, value)

    def test_period_reuse_and_csv_digest(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'fixture.csv'
            metadata = csv_fixture(file, 1020, 3)
            with file.open(newline='') as f:
                rows = list(csv.reader(f))
            self.assertEqual(metadata['sha256'], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual(rows[1], rows[1010])
            for c in range(3):
                self.assertAlmostEqual(mean(1020, c), sum(float(r[c]) for r in rows[1:])/1020)


class DistributionTest(unittest.TestCase):
    def test_replacement_retains_whole_original_point_and_rejects_cherry_picking(self):
        base = dict.fromkeys(DIMS, '')
        old = [{**base, 'i': i, 'status': 'error'} for i in ('-1', '1', '2')]
        other = {**base, 'case': 'steady', 'i': '1'}
        redo = [{**row, 'status': 'ok'} for row in old]
        active, history, keys = replace_points([*old, other], redo, set())
        self.assertEqual(active, [other])
        self.assertEqual(history, old)
        with self.assertRaises(ValueError):
            replace_points(old, redo[1:], set())
        with self.assertRaises(ValueError):
            replace_points(old, redo, set(keys))

    def test_p95_requires_thirty_successes_and_attempts_are_not_dropped(self):
        base = dict.fromkeys(DIMS, '')
        def row(i, ms='', *, status='ok', phase='register', warmup='0'):
            return {**base, 'phase': phase, 'i': str(i), 'warmup': warmup, 'status': status, 'elapsed_ms': str(ms)}
        records = [row(i, i) for i in range(1, 30)] + [row(30, status='timeout', phase='attempt'), row(-1, 0, warmup='1')]
        summary = summarize(records)[0]
        self.assertEqual(summary['attempts'], 30)
        self.assertEqual(summary['status'], {'ok': 29, 'not_reached': 1})
        self.assertEqual(summary['metrics']['elapsed_ms']['p50'], 15)
        self.assertIsNone(summary['metrics']['elapsed_ms']['p95'])
        p95 = summarize(records[:29] + [row(30, 30)])[0]['metrics']['elapsed_ms']['p95']
        self.assertAlmostEqual(p95, 28.55)
        self.assertAlmostEqual(percentile([1, 5], .95), 4.8)


if __name__ == '__main__':
    unittest.main()
