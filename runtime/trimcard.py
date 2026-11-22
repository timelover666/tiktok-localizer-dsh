#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动检测并剪掉全屏引流卡（平台榜单/商品列表/活动页）。

用法:
  trimcard.py --work <work_dir> [--out <batch_root>] [--apply] [--min-sec 2.5] [--min-area 0.35]

不带 --apply 时只报告检测结果；带 --apply 时真的剪裁并同步 events / zh.json / probe 的时间轴。
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.join(HERE, "bin", "ffmpeg")

CARD_WORDS = re.compile(
    r"(amazon|アマゾン|楽天|rakuten|쿠팡|coupang|ランキング|ranking|榜单|排行|畅销|"
    r"商品一覧|商品列表|おすすめ商品|세일|sale|クーポン|优惠券|価格比較|比价|"
    r"売れ筋|인기상품|人气商品|best\s*seller)", re.I)


def load(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(p, data):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def run(cmd, timeout=1800):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def detect_cards(events, w, h, duration, min_sec=2.5, min_area=0.35):
    """把画面文字密集、覆盖面积大的时段识别为全屏卡片。"""
    if not events:
        return []
    all_buckets = []      # 全部文字（只用来数密度）
    buckets = []          # 较大文字（用来算卡片区域）
    for e in events:
        t0, t1 = float(e["t0"]), float(e["t1"])
        ew = max(0.0, float(e["x1"]) - float(e["x0"]))
        eh = max(0.0, float(e["y1"]) - float(e["y0"]))
        row = (t0, t1, float(e["x0"]), float(e["y0"]), float(e["x1"]), float(e["y1"]),
               str(e.get("text") or ""))
        all_buckets.append(row)
        if ew * eh < 0.004 * w * h:      # 太小的字不参与区域计算
            continue
        buckets.append(row)

    # 逐秒扫描
    segs = []
    t = 0.0
    while t < duration:
        active = [b for b in buckets if b[0] - 1e-6 <= t <= b[1] + 1e-6]
        dens = len([b for b in all_buckets if b[0] - 1e-6 <= t <= b[1] + 1e-6])
        if len(active) >= 4:
            # 覆盖面积用外接框近似
            x0 = min(b[2] for b in active); y0 = min(b[3] for b in active)
            x1 = max(b[4] for b in active); y1 = max(b[5] for b in active)
            area = max(0.0, (x1 - x0)) * max(0.0, (y1 - y0)) / float(w * h)
            has_word = any(CARD_WORDS.search(b[6]) for b in active)
            # 必须命中平台/榜单/优惠券关键词才算引流卡，避免把玩具展示、字幕墙误剪
            # 卡片判断再加两条：文字块要从画面上半部开始，且纵向跨度够大
            # （避免把「产品特写 + 底部字幕」误当成卡片）
            top_start = y0 < 0.45 * h
            tall = (y1 - y0) >= 0.28 * h
            if has_word and top_start and tall and dens >= 12 and area >= 0.28:
                segs.append((t, t + 0.5, area, True))
        t += 0.5

    # 合并相邻秒
    merged = []
    for s0, s1, area, has_word in segs:
        if merged and s0 - merged[-1][1] <= 0.8:
            m = merged[-1]
            m[1] = s1; m[2] = max(m[2], area); m[3] = m[3] or has_word
        else:
            merged.append([s0, s1, area, has_word])
    return [(a, b) for a, b, area, hw in merged if b - a >= min(0.8, min_sec)]


def plan_keep(cuts, duration):
    keep = []
    cur = 0.0
    for a, b in sorted(cuts):
        if a > cur + 0.05:
            keep.append((cur, min(a, duration)))
        cur = max(cur, b)
    if cur < duration - 0.05:
        keep.append((cur, duration))
    return keep


def cut_video(src, dst, keep):
    """按保留区间拼接（一次编码）。"""
    if not keep:
        return False
    parts = []
    for i, (a, b) in enumerate(keep):
        parts.append("[0:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS[v%d]" % (a, b, i))
        parts.append("[0:a]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS[a%d]" % (a, b, i))
    n = len(keep)
    seq = "".join("[v%d][a%d]" % (i, i) for i in range(n))
    fc = ";".join(parts) + ";" + seq + "concat=n=%d:v=1:a=1[vo][ao]" % n
    rc, out, err = run([FFMPEG, "-v", "error", "-y", "-i", src,
                        "-filter_complex", fc, "-map", "[vo]", "-map", "[ao]",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                        "-c:a", "aac", "-b:a", "128k", dst])
    return rc == 0


def shift_time(t, cuts):
    """把原时间映射到剪裁后的时间。"""
    delta = 0.0
    for a, b in sorted(cuts):
        if t >= b:
            delta += (b - a)
        elif t > a:
            return a - delta
    return t - delta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--min-sec", type=float, default=2.5)
    ap.add_argument("--min-area", type=float, default=0.35)
    ap.add_argument("--ffmpeg", default=FFMPEG)
    args = ap.parse_args()

    work = args.work
    probe = load(os.path.join(work, "probe.json"), {}) or {}
    events = load(os.path.join(work, "events.json"), []) or []
    zh = load(os.path.join(work, "zh.json"), {}) or {}
    w = int(probe.get("width") or 720)
    h = int(probe.get("height") or 1280)
    duration = float(zh.get("duration") or probe.get("duration") or 0.0)
    src = os.path.join(work, "source.mp4")
    if not os.path.exists(src):
        print(json.dumps({"ok": False, "error": "缺少 source.mp4"}, ensure_ascii=False))
        return

    cuts = detect_cards(events, w, h, duration, args.min_sec, args.min_area)
    result = {"ok": True, "cuts": [[round(a, 2), round(b, 2)] for a, b in cuts],
              "removed": round(sum(b - a for a, b in cuts), 2), "applied": False}
    if not cuts:
        print(json.dumps(result, ensure_ascii=False))
        return
    if not args.apply:
        print(json.dumps(result, ensure_ascii=False))
        return

    keep = plan_keep(cuts, duration)
    full = os.path.join(work, "source_full.mp4")
    if not os.path.exists(full):
        os.rename(src, full)
        src = full
    else:
        src = full
    tmp = os.path.join(work, "source_trimcard.mp4")
    if not cut_video(src, tmp, keep):
        print(json.dumps({"ok": False, "error": "剪裁失败"}, ensure_ascii=False))
        return
    os.replace(tmp, os.path.join(work, "source.mp4"))
    new_dur = round(duration - sum(b - a for a, b in cuts), 3)

    # 同步所有时间轴
    for e in events:
        e["t0"] = round(shift_time(float(e["t0"]), cuts), 3)
        e["t1"] = round(shift_time(float(e["t1"]), cuts), 3)
    events = [e for e in events if e["t1"] > e["t0"] + 0.02]
    save(os.path.join(work, "events.json"), events)
    subs = []
    for s in (zh.get("extra_subs") or []):
        s2 = dict(s)
        s2["t0"] = round(shift_time(float(s["t0"]), cuts), 3)
        s2["t1"] = round(shift_time(float(s["t1"]), cuts), 3)
        if s2["t1"] - s2["t0"] >= 0.2:
            subs.append(s2)
    zh["extra_subs"] = subs
    zh["duration"] = new_dur
    save(os.path.join(work, "zh.json"), zh)
    probe["duration"] = new_dur
    save(os.path.join(work, "probe.json"), probe)
    summ = load(os.path.join(work, "summary.json"), {}) or {}
    if summ:
        summ["duration"] = new_dur
        save(os.path.join(work, "summary.json"), summ)
    result.update({"applied": True, "duration_before": duration, "duration_after": new_dur})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
