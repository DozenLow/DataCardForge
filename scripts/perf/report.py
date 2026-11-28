#!/usr/bin/env python3
"""Summarize measured attempts and produce a self-contained offline ECharts report."""

import argparse
import collections
import csv
import json
import math
import re
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DIMS = ('suite', 'case', 'rows', 'cols', 'width', 'depth', 'lanes', 'missing', 'memory_limit_bytes')
METRICS = ('elapsed_ms', 'cards_per_s', 'request_bytes', 'response_bytes', 'requests',
           'displayed_rows', 'result_rows', 'points_in', 'points_out', 'frames', 'frame_gap_p50_ms', 'frame_gap_p95_ms', 'frame_gap_max_ms',
           'backend_peak_rss_bytes', 'backend_steady_rss_bytes', 'browser_tree_peak_sampled_bytes',
           'browser_tree_steady_sampled_bytes', 'cgroup_peak_bytes', 'cgroup_steady_bytes',
           'retained_tables', 'recovery')


def percentile(data, q):
    ordered = sorted(data)
    at = (len(ordered) - 1) * q
    lo = int(at)
    return ordered[lo] + (ordered[math.ceil(at)] - ordered[lo]) * (at - lo)


def summarize(rows):
    cases = collections.defaultdict(list)
    for r in rows:
        if r['warmup'] == '0':
            cases[tuple(r[k] for k in DIMS)].append(r)
    summary = []
    for key, records in cases.items():
        dim = dict(zip(DIMS, key))
        attempts = len({r['i'] for r in records if int(r['i']) > 0})
        by_phase = collections.defaultdict(list)
        for r in records:
            by_phase[r['phase']].append(r)
        for phase, batch in by_phase.items():
            counts = collections.Counter(r['status'] for r in batch)
            if attempts > len(batch):
                counts['not_reached'] = attempts - len(batch)
            metrics = {}
            for k in METRICS:
                vals = [float(r[k]) for r in batch if r.get(k) and (
                    r['status'] == 'ok' or phase == 'capacity' and k != 'elapsed_ms')]
                if vals:
                    metrics[k] = {'n': len(vals), 'min': min(vals), 'p50': statistics.median(vals),
                                  'max': max(vals), 'p95': percentile(vals, .95) if len(vals) >= 30 else None}
            details = list(dict.fromkeys(r['detail'] for r in sorted(batch, key=lambda x: x['status'] == 'ok')
                                         if r.get('detail')))[:4]
            summary.append({**dim, 'phase': phase, 'attempts': attempts, 'status': dict(counts),
                            'metrics': metrics, 'detail': details})
    return summary


HTML = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DataCardForge · 性能基准</title><style>
:root {color-scheme:light;--text:#142534;--muted:#526a78;--line:#d5e0e5;--paper:#f0f5f6;--accent:#0f756d} *{box-sizing:border-box}
body{margin:0;font:15px/1.6 system-ui,sans-serif;background:var(--paper);color:var(--text)} header{background:#102b3a;color:#fff;padding:36px max(20px,calc((100vw - 1300px)/2));border-bottom:5px solid #35bba3}
header p{color:#c4dce4;margin-bottom:0} h1{font-size:clamp(23px,4vw,36px);margin:0} h2{margin:.1em 0 .45em;font-size:21px}
main{max-width:1340px;margin:0 auto;padding:20px;display:grid;gap:16px} section,details{border:1px solid var(--line);border-radius:11px;background:#fff;padding:17px 19px}
small,.muted{color:var(--muted)} a{color:var(--accent)} select{font:inherit;padding:5px;max-width:100%;margin-right:8px} pre{white-space:pre-wrap;overflow-wrap:anywhere}
.chart{width:100%;height:380px} .tablescroll{max-height:430px;overflow:auto} table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums} td,th{text-align:left;padding:7px;border-bottom:1px solid var(--line)} th{position:sticky;top:0;background:#f6fafb} td:last-child{min-width:145px} .empty{color:var(--muted);padding:10px 0}
</style></head><body><header><h1>DataCardForge · 性能基准</h1><p id="subtitle"></p></header><main>
<section><strong>阅读口径：</strong>只对通过数值/形状校验的样本汇总延迟。至少 30 个成功样本才显示跨尝试 p95；其他点看中位数、范围和失败数。阶段可以重叠，不能叠加求总耗时。耗时没有做跨机器归一化。<br>
原始数据：<a href="samples.csv">逐次样本</a>，<a href="summary.csv">汇总表</a>，<a href="manifest.json">环境清单</a>。<br>在 DataCardForge 画图：导入 <a href="datacardforge.csv">纯数值规模表</a>，X 选 rows，Y 可选 JSON/DCM2 注册或首格 p50；缺值表示没有对应测量值（也可能是成功次数不足）。<label> 图中统计量 <select id="stat"><option>p50</option><option>p95</option><option>min</option><option>max</option></select></label></section>
<section><h2>① 浏览器：真实操作的等待和帧间隔</h2><p class="muted">首格指正确单元格已进入 DOM 并完成布局，不保证未被弹窗遮挡。滚动由程序设置真实视口的 scrollTop，测末行渲染，不测用户滚动时间。本地表格能生成，不等于上传成功；HTTP 413 仍计为注册失败。若绘图前需确认阻断弹窗，首次绘图计入这次点击。缩放的 p95 帧间隔来自一次交互，不是跨尝试 p95。</p><div id="browserControls"></div><div class="chart" id="browserChart"></div></section>
<section><h2>② 规模：API 首窗 / 引擎计算</h2><p class="muted">选择同列宽的行数阶梯、同一行数的列宽阶梯，或方阵。JSON 和 DCM2 是两条独立入口；引擎不含网络、准备和校验。</p><div id="scaleControls"></div><div class="chart" id="scaleChart"></div></section>
<section><h2>③ 并发：一个源更新触发一个波次</h2><p class="muted">首/尾 done 是客户端看到事件的时间，可能出自同一个批次。与 PATCH ACK 重叠，不代表引擎独占时间。</p><div id="waveControls"></div><div class="chart" id="waveChart"></div></section>
<section><h2>④ 内存：高水位与空闲稳态</h2><p class="muted">后端用进程 VmHWM/VmRSS；浏览器进程树按 50 ms 采样求 RSS 和，共享页可能重复计入。两者不与 cgroup memory.peak 混算。</p><div id="memoryControls"></div><div class="chart" id="memoryChart"></div></section>
<section><h2>⑤ 边界与运行结果</h2><p class="muted">HTTP 413 不是 OOM；缺少委派内存组的容量点标为阻塞。没有成功值的点不会画成零。</p><div id="capacityControls"></div><div class="chart" id="capacityChart"></div><label>筛选 <select id="filter"></select></label><div class="tablescroll"><table><thead><tr><th>分组 / 阶段</th><th>尺寸与配置</th><th>尝试 / 状态</th><th>中位数 / p95 / 范围 (ms)</th><th>证据</th></tr></thead><tbody id="result"></tbody></table></div></section>
<details><summary>构建、机器、版本与实验口径</summary><pre id="manifest"></pre></details>
</main><script>__ECHARTS__</script><script>
const data=__DATA__, rows=data.summary, fmt=(x)=>x==null?'—':Number(x).toLocaleString('zh-CN',{maximumFractionDigits:3});
const elem=id=>document.getElementById(id);
elem('subtitle').textContent=`构建 ${data.manifest.expected_hello_build} · ${data.manifest.cpu} · ${data.manifest.started_utc} · ${data.manifest.complete?'跑完试验矩阵':'中断或尚未跑完'}`;
elem('manifest').textContent=JSON.stringify(data.manifest,null,2);
if(data.manifest.superseded_samples){
 const link=document.createElement('a'); link.href='superseded.csv'; link.textContent='被复测替换的原始样本';
 elem('manifest').before(link);
}
const colors=['#007e76','#3168b2','#bf5d10','#6947ab','#a4376f','#40825c','#44566e','#ba4137','#477c8f'];
const dim=r=>`${r.rows}×${r.cols}${r.width?` · 并发 ${r.width} / 深度 ${r.depth} / lane ${r.lanes}`:''}${r.missing==='1'?' · 含缺测':''}${r.memory_limit_bytes?` · ${+r.memory_limit_bytes/2**30} GiB`:''}`;
const status=r=>Object.entries(r.status).map(([k,v])=>`${k} ${v}`).join(' / ');
function sel(id, values, names) {
 const s=document.createElement('select'); for(const v of values){const o=new Option(names?.[v]??v,v);s.add(o)} elem(id).append(s);return s;
}
function render(id, records, metric, x, series, opts={}) {
 const chart=echarts.getInstanceByDom(elem(id))??echarts.init(elem(id));
 const map=new Map();
 const divisor=opts.divisor??1;
 for(const row of records){const m=row.metrics[metric], val=m?.[elem('stat').value];if(val==null)continue;const key=series(row);if(!map.has(key))map.set(key,[]);
  map.get(key).push({value:[x(row),val/divisor],row,m});}
 const plotted=[...map].map(([name,list])=>({name,type:opts.bar?'bar':'line',showSymbol:true,symbolSize:7,
  data:list.sort((a,b)=>a.value[0]-b.value[0])}));
 chart.setOption({animation:false,color:colors,grid:{left:76,right:37,top:60,bottom:56},legend:{type:'scroll',top:6},
  xAxis:{type:opts.bar?'category':'value',name:opts.xName??'',scale:true,
   axisLabel:{formatter:v=>opts.bar?v:fmt(v)},...(opts.bar?{data:[...new Set(records.map(x))]}:{})},
  yAxis:{type:'value',name:opts.unit??'ms',min:0},
  tooltip:{trigger:'item',confine:true,renderMode:'richText',formatter:p=>{const {m,row}=p.data;return `${p.seriesName} · ${dim(row)}\n中位数 ${fmt(m.p50/divisor)} ${opts.unit??'ms'}\np95 ${fmt(m.p95==null?null:m.p95/divisor)}\n范围 ${fmt(m.min/divisor)}–${fmt(m.max/divisor)} · n=${m.n}\n${status(row)}`;}},
  graphic:plotted.length?[]:[{type:'text',left:'center',top:'middle',style:{text:'无可绘制的实测值；见下方状态表',fill:'#526a78',font:'15px sans-serif'}}],series:plotted},true);
}
const axisLabels={row:'行数（固定列宽）',col:'列数（固定行数）',size:'方阵边长'};
const brMode=sel('browserControls',['import','cold','chart','import_steady']);
const brAxis=sel('browserControls',['row','col'],axisLabels);
const brMetric=sel('browserControls',['elapsed_ms','points_in','points_out','frame_gap_p50_ms','frame_gap_p95_ms','frame_gap_max_ms','frames','displayed_rows','result_rows','request_bytes','response_bytes','requests'],{elapsed_ms:'时间 (ms)',points_in:'图表输入点数',points_out:'送入 ECharts 的点数',frames:'采集帧数',frame_gap_p50_ms:'帧间隔 p50',frame_gap_p95_ms:'帧间隔 p95',frame_gap_max_ms:'最大帧间隔',displayed_rows:'实际显示行数',result_rows:'结果行数',request_bytes:'请求体 (MiB)',response_bytes:'响应体 (MiB)',requests:'请求数'});
const scales=sel('scaleControls',['api','elem','reduce','quantile','window','matmul','solve','boundary']);
const scAxis=sel('scaleControls',['row','col','size'],axisLabels);
const scPhase=sel('scaleControls',['register','first_window','formula_readable','summary_readable','compute']);
const waveKind=sel('waveControls',['width','depth'],{width:'固定深度，改变宽度',depth:'固定宽度，改变深度'});
const waveM=sel('waveControls',['elapsed_ms','cards_per_s'],{elapsed_ms:'事件时间',cards_per_s:'卡/秒'});
const memMode=sel('memoryControls',['browser','api','wave']);
const memM=sel('memoryControls',['backend_peak_rss_bytes','backend_steady_rss_bytes','browser_tree_peak_sampled_bytes','browser_tree_steady_sampled_bytes'],{backend_peak_rss_bytes:'后端峰值',backend_steady_rss_bytes:'后端稳态',browser_tree_peak_sampled_bytes:'浏览器树采样峰值',browser_tree_steady_sampled_bytes:'浏览器树采样稳态'});
const capM=sel('capacityControls',['retained_tables','cgroup_peak_bytes','cgroup_steady_bytes','recovery'],{retained_tables:'留存表数',cgroup_peak_bytes:'内存组峰值',cgroup_steady_bytes:'内存组稳态',recovery:'小请求恢复 (0/1)'});
const dense=(r,axis)=>r.missing!=='1'&&(axis==='row'?r.cols==='20':axis==='col'?r.rows==='100000':r.rows===r.cols);
function draw(){
 const bytesBr=brMetric.value.endsWith('_bytes');
 render('browserChart',rows.filter(r=>r.suite==='browser'&&r.case===brMode.value&&dense(r,brAxis.value)), brMetric.value,r=>+(brAxis.value==='row'?r.rows:r.cols),r=>r.phase,{xName:brAxis.value==='row'?'行':'列',unit:bytesBr?'MiB':brMetric.value.endsWith('_ms')?'ms':'数量',divisor:bytesBr?2**20:1});
 const s=scales.value, engine=!['api','boundary'].includes(s), sq=['matmul','solve'].includes(s), one=['reduce','quantile','window'].includes(s);
 scPhase.disabled=engine;scAxis.disabled=sq||one||s==='boundary';
 const axis=sq?'size':(one||s==='boundary'?'row':scAxis.value==='size'?'row':scAxis.value);
 render('scaleChart',rows.filter(r=>(engine?r.suite==='engine'&&r.case===s:r.suite===s)&&r.phase===(engine?'compute':scPhase.value)&&(one||dense(r,axis))), 'elapsed_ms',r=>+(axis==='col'?r.cols:r.rows),r=>r.case,{xName:axis==='size'?'N':axis==='row'?'行':'列'});
 render('waveChart',rows.filter(r=>r.suite==='wave'&&r.case===waveKind.value || r.suite==='wave'&&waveKind.value==='depth'&&r.depth==='1'&&r.width==='1'&&r.lanes==='8'),waveM.value,r=>+r[waveKind.value],r=>`${r.phase} · lane ${r.lanes}`,{xName:waveKind.value==='width'?'宽':'深',unit:waveM.value==='elapsed_ms'?'ms':'卡/秒'});
 render('memoryChart',rows.filter(r=>r.suite===memMode.value&&r.phase==='memory'&&r.missing!=='1'&&(r.cols==='20'||r.suite==='wave'&&r.depth==='1')),memM.value,r=>+(r.suite==='wave'?r.width:r.rows),r=>r.suite==='wave'?`lane ${r.lanes}`:r.case,{xName:memMode.value==='wave'?'宽':'行',unit:'MiB',divisor:2**20});
 const bytes=capM.value.endsWith('_bytes');
 render('capacityChart',rows.filter(r=>r.suite==='capacity'),capM.value,r=>`${+r.memory_limit_bytes/2**30} GiB`,r=>r.case,{bar:true,unit:bytes?'MiB':capM.value==='recovery'?'0/1':'表',divisor:bytes?2**20:1});
}
for(const s of [elem('stat'),brMode,brAxis,brMetric,scales,scAxis,scPhase,waveKind,waveM,memMode,memM,capM])s.onchange=draw;
const filter=elem('filter'); for(const k of ['边界和异常','全部',...new Set(rows.map(r=>r.suite))])filter.add(new Option(k,k));
function table(){const frag=document.createDocumentFragment();for(const r of rows){const f=filter.value;
 if(f==='边界和异常'&&!(r.suite==='boundary'||r.suite==='capacity'||Object.keys(r.status).some(k=>k!=='ok')))continue;
 if(f!=='边界和异常'&&f!=='全部'&&r.suite!==f)continue;const m=r.metrics.elapsed_ms;
 const tr=document.createElement('tr');for(const v of [`${r.suite}/${r.case} · ${r.phase}`,dim(r),`${r.attempts} / ${status(r)}`,
  m?`${fmt(m.p50)} / ${fmt(m.p95)} / ${fmt(m.min)}–${fmt(m.max)}`:'—',r.detail.join('; ')||'—']){const td=document.createElement('td');td.textContent=v;tr.append(td)}frag.append(tr);
 }elem('result').replaceChildren(frag);}
filter.onchange=table;table();draw();
window.addEventListener('resize',()=>document.querySelectorAll('.chart').forEach(e=>echarts.getInstanceByDom(e)?.resize()));
</script></body></html>'''


def write_summary(path, summary):
    with path.open('w', newline='', encoding='utf-8') as f:
        fields = [*DIMS, 'phase', 'attempts', 'ok', 'status', *[f'{k}_{s}' for k in METRICS for s in ('n', 'p50', 'p95', 'min', 'max')]]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in summary:
            cols = {k: r[k] for k in (*DIMS, 'phase', 'attempts')}
            cols['ok'] = r['status'].get('ok', 0)
            cols['status'] = ' / '.join(f'{k}:{v}' for k, v in r['status'].items())
            cols.update({f'{k}_{s}': val for k, m in r['metrics'].items() for s, val in m.items()})
            w.writerow(cols)


def write_numeric(path, summary):
    # One row per dense 20-column shape; no text cells. NA is DataCardForge's
    # missing-value marker, including unavailable percentiles (not zero).
    series = {('api', 'json', 'register'): 'api_json_register',
              ('api', 'raw', 'register'): 'api_dcm2_register',
              ('browser', 'import', 'first_cell'): 'browser_first_cell',
              ('engine', 'elem', 'compute'): 'engine_elem'}
    rows = collections.defaultdict(dict)
    for r in summary:
        prefix = series.get((r['suite'], r['case'], r['phase']))
        if not prefix or r['cols'] != '20' or r['missing'] == '1':
            continue
        values = r['metrics'].get('elapsed_ms', {})
        rows[int(r['rows'])].update({f'{prefix}_ok': r['status'].get('ok', 0),
                                    **{f'{prefix}_{q}_ms': values.get(q) for q in ('p50', 'p95')}})
    fields = ['rows', 'cols', *[f'{name}_{suffix}' for name in series.values()
                                for suffix in ('p50_ms', 'p95_ms', 'ok')]]
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(fields)
        for size, data in sorted(rows.items()):
            w.writerow([size, 20, *['NA' if data.get(k) is None else data[k] for k in fields[2:]]])


def point_key(row):
    return tuple(row[k] for k in DIMS)


def replace_points(raw, batch, replaced):
    def attempts(records):
        result = collections.defaultdict(set)
        for row in records:
            result[point_key(row)].add(row['i'])
        return result
    new, old = attempts(batch), attempts(raw)
    if not new or any(key in replaced or old.get(key) != indices for key, indices in new.items()):
        raise ValueError('replacement must match existing point dimensions and attempt IDs once')
    active, superseded = [], []
    for row in raw:
        (superseded if point_key(row) in new else active).append(row)
    return active, superseded, new.keys()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--include', nargs='+', type=Path, default=[], help='additional, non-overlapping run suites on the same machine/build')
    parser.add_argument('--out', type=Path, help='new report directory when assembling multiple runs')
    parser.add_argument('--replace-points', nargs='+', type=Path, default=[],
                        help='replace whole points by separately rerun attempts; preserve originals in superseded.csv')
    parser.add_argument('--replacement-reason', help='required explanation when using --replace-points')
    parser.add_argument('--echarts', type=Path, default=ROOT/'web/node_modules/echarts/dist/echarts.min.js')
    args = parser.parse_args()
    if (args.include or args.replace_points) and not args.out:
        parser.error('--include and --replace-points require --out')
    if args.replace_points and not args.replacement_reason:
        parser.error('--replace-points requires --replacement-reason')
    manifests, raw, fields, seen = [], [], None, set()
    superseded, explanations, replaced = [], [], set()
    for path in [args.run, *args.include, *args.replace_points]:
        manifests.append(json.loads((path/'manifest.json').read_text()))
        with (path/'samples.csv').open(newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            if fields is not None and reader.fieldnames != fields:
                parser.error('sample schemas differ')
            fields = reader.fieldnames
            batch = list(reader)
        if path in args.replace_points:
            if not manifests[-1]['complete']:
                parser.error(f'incomplete replacement run: {path}')
            try:
                raw, previous, new = replace_points(raw, batch, replaced)
            except ValueError as e:
                parser.error(f'{path}: {e}')
            superseded.extend(previous)
            explanations.append({'run': str(path), 'reason': args.replacement_reason,
                                 'points': [dict(zip(DIMS, key)) for key in new]})
            replaced.update(new)
        else:
            suites = {r['suite'] for r in batch}
            if suites & seen:
                parser.error(f'cannot combine overlapping suites: {suites & seen}')
            seen.update(suites)
        raw.extend(batch)
    manifest, summary = manifests[0], summarize(raw)
    if any((m['git_sha'], m['cpu'], m['os'], m['artifacts']) !=
           (manifest['git_sha'], manifest['cpu'], manifest['os'], manifest['artifacts']) for m in manifests):
        parser.error('runs do not share the same build and machine metadata')
    run = args.run.resolve() if args.out is None else args.out.resolve()
    if args.out is not None:
        run.mkdir(parents=True, exist_ok=False)
        if len(manifests) > 1:
            manifest = {**manifest, 'browser_versions': sorted({x for m in manifests for x in m['browser_versions']}),
                        'complete': all(m['complete'] for m in manifests), 'source_runs': manifests,
                        'started_utc': min(m['started_utc'] for m in manifests),
                        'finished_utc': max(m['finished_utc'] for m in manifests)}
        if explanations:
            manifest = {**manifest, 'replaced_points': explanations, 'superseded_samples': 'superseded.csv'}
            with (run/'superseded.csv').open('x', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fields)
                writer.writeheader()
                writer.writerows(superseded)
        with (run/'samples.csv').open('x', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(raw)
        (run/'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    payload = json.dumps({'manifest': manifest, 'summary': summary}, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c')
    bundle = re.sub(r'</script', lambda _: r'<\/script', args.echarts.read_text(encoding='utf-8'), flags=re.I)
    write_summary(run/'summary.csv', summary)
    write_numeric(run/'datacardforge.csv', summary)
    (run/'report.html').write_text(HTML.replace('__DATA__', payload).replace('__ECHARTS__', bundle, 1), encoding='utf-8')


if __name__ == '__main__':
    main()
