#!/usr/bin/env python3
"""QC — 对成片抽帧复检 + 字幕覆盖/规范检查。

用法:
  python3 qc.py --work <workdir> --index 3 --out <batchDir>

检查项：
  1. 价格 / 引流信息残留（对成片抽帧重新 OCR，仍能识别到价格/联系方式即漏遮）
  2. 疑似水印（同一段文字长期固定在同一位置）
  3. 漏译：画面外文没有对应中文、口播没有对应字幕
  4. 字幕规范：标点、超长、多行、过短时间
产物：workdir/qc.json，并打印 QC_OK {json}
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import compose  # noqa: E402  (复用正则与清洗规则)

CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
FOREIGN = re.compile(r"[\u3040-\u30ff\uac00-\ud7afA-Za-z]")
COVER = re.compile(r"[\u3000-\u303f\uff01-\uff5e\u2010-\u2027`~!@#$%^&*()+=<>?]")
# 复用 compose 的片尾/水印正则
CTA_TAIL = compose.CTA_TAIL
CTA_TAIL_EN = compose.CTA_TAIL_EN
WM_WORD = compose.WM_WORD


def log(*a):
    print(*a, flush=True)


def progress(ratio, stage, message=""):
    log("PROGRESS %s %s %s" % (round(float(ratio), 3), stage, message))


def run(cmd, timeout=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("command failed: %s\n%s" % (" ".join(cmd[:4]), (p.stderr or "")[-800:]))
    return p


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)


def norm(s):
    return "".join(ch.lower() for ch in str(s) if ch.isalnum())


def sim(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a.startswith(b) or b.startswith(a):
        return 0.9
    la, lb = len(a), len(b)
    prev = [0] * (lb + 1)
    for i in range(1, la + 1):
        cur = [0] * (lb + 1)
        ai = a[i - 1]
        for j in range(1, lb + 1):
            cur[j] = prev[j - 1] + 1 if ai == b[j - 1] else max(prev[j], cur[j - 1])
        prev = cur
    return prev[lb] / float(max(la, lb))


def parse_srt(path):
    entries = []
    if not os.path.exists(path):
        return entries
    text = open(path, encoding="utf-8", errors="replace").read().replace("\r", "")
    for block in re.split(r"\n\n+", text.strip()):
        lines = block.split("\n")
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        try:
            left = lines[1].split("-->")[0].strip()
            h, m, rest = left.split(":")
            s = float(rest.replace(",", "."))
            t0 = int(h) * 3600 + int(m) * 60 + s
            right = lines[1].split("-->")[1].strip()
            h2, m2, rest2 = right.split(":")
            t1 = int(h2) * 3600 + int(m2) * 60 + float(rest2.replace(",", "."))
        except ValueError:
            continue
        body = lines[2:]
        src = body[0] if len(body) >= 2 else ""
        zh = body[-1] if len(body) >= 2 else body[0]
        entries.append(dict(t0=t0, t1=t1, src=src.strip(), zh=zh.strip()))
    return entries


def ocr_frames(ff, ocr, video, work, fps, width, jobs=6):
    fdir = os.path.join(work, "_qc_frames")
    if os.path.isdir(fdir):
        shutil.rmtree(fdir)
    os.makedirs(fdir, exist_ok=True)
    run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", video,
         "-vf", "fps=%s,scale=%d:-2" % (fps, width), "-q:v", "3",
         os.path.join(fdir, "q_%05d.jpg")])
    names = sorted(n for n in os.listdir(fdir) if n.endswith(".jpg"))
    paths = [os.path.join(fdir, n) for n in names]
    if not paths:
        return [], 0
    chunks = [paths[i::jobs] for i in range(jobs)]
    procs = []
    for chunk in chunks:
        if chunk:
            procs.append(subprocess.Popen([ocr] + chunk, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, text=True))
    rows = []
    for p in procs:
        out = p.communicate()[0] or ""
        for line in out.splitlines():
            line = line.strip()
            if line:
                rows.append(line)
    frames = []
    for line in rows:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        m = re.search(r"(\d+)", os.path.basename(d.get("f") or ""))
        if not m:
            continue
        idx = int(m.group(1))
        fw, fh = float(d.get("w") or width), float(d.get("h") or 1280)
        items = []
        for l in d.get("lines") or []:
            t = (l.get("t") or "").strip()
            if not t:
                continue
            items.append(dict(text=t, c=l.get("c", 0.0),
                              x=l["x"], y=1.0 - l["y"] - l["h"], w=l["w"], h=l["h"]))
        frames.append(dict(idx=idx, t=(idx - 1) / float(fps), items=items))
    frames.sort(key=lambda f: f["idx"])
    shutil.rmtree(fdir, ignore_errors=True)
    return frames, len(paths)


def meaningful(text):
    if len(re.sub(r"\s", "", text)) < 4:
        return False
    alnum = sum(1 for ch in text if ch.isalnum() or CJK.match(ch))
    return alnum >= len(text) * 0.6


def check(frames, duration, translated):
    issues = []
    counts = Counter()

    # 1) 价格 / 引流残留：只看真正的价格符号或明确的引流词
    promo_hits = defaultdict(list)
    for f in frames:
        for it in f["items"]:
            text = it["text"]
            if it.get("c", 0) < 0.3:
                continue
            hit = compose.PRICE.search(text)
            if not hit and compose.CTA.search(text) and re.search(r"\d", text):
                hit = True
            if hit and meaningful(text):
                promo_hits[norm(text)].append((f["t"], text, it))

    for key, hits in promo_hits.items():
        times = sorted(t for t, _, _ in hits)
        text = hits[0][1]
        if len(hits) >= 2:
            first = hits[0][2]
            issues.append(dict(
                type="promo", severity="high", t=round(times[0], 2), text=text,
                detail="成片里仍能识别到价格/引流文字（共 %d 帧）" % len(hits),
                advice="补遮罩：把这段时间里该区域一起模糊掉",
                box=dict(x=first["x"], y=first["y"], w=first["w"], h=first["h"]),
                t1=round(times[-1] + 0.6, 2),
            ))
            counts["promo"] += 1

    # 2) 疑似水印：长期固定位置、且没有被翻译的常驻文字
    if len(frames) >= 8:
        buckets = defaultdict(list)
        for f in frames:
            for it in f["items"]:
                t = norm(it["text"])
                if not meaningful(it["text"]) or compose.PRICE.search(it["text"]):
                    continue
                if t in translated:
                    continue
                # 底部字幕带是我们自己烧的中文，OCR 常把它误读成“常驻外文”，跳过
                yy = float(it.get("y") or 0)
                if 0.74 <= yy <= 0.96:
                    continue
                buckets[t].append((f["t"], it["x"], it["y"]))
        for text, seen in buckets.items():
            if len(seen) < max(8, len(frames) * 0.6):
                continue
            xs = [s[1] for s in seen]
            ys = [s[2] for s in seen]
            if max(xs) - min(xs) < 0.06 and max(ys) - min(ys) < 0.06:
                issues.append(dict(
                    type="watermark", severity="medium", t=round(seen[0][0], 2),
                    text=text,
                    detail="疑似水印/常驻文字：约 %d%% 的抽帧在同一位置出现且没有译文" % int(100 * len(seen) / max(1, len(frames))),
                    advice="确认是否要整段抹掉该位置",
                    box=dict(x=min(xs), y=min(ys), w=max(xs) - min(xs), h=max(ys) - min(ys)),
                    t1=round(duration, 2),
                ))
                counts["watermark"] += 1

    return issues, counts


# ---------- 新增：字幕/遮罩/剪辑 质检项（按用户反馈固化） ----------

HALF_END = re.compile(r"(而|和|与|或|的|在|把|用|从|就|也|都|跟|给|让|被|地|得)$")


def check_subtitle_quality(srt, zh, duration):
    """重复字幕、半截句、字号过小 —— 用户提过的字幕质量问题。"""
    issues = []
    counts = Counter()
    # 1) 同义重复：时间重叠且文本相似，只该留一条
    for i, a in enumerate(srt):
        if not a.get("zh"):
            continue
        for b in srt[i + 1:]:
            if b["t0"] >= a["t1"] - 0.05:
                break
            if not b.get("zh"):
                continue
            overlap = min(a["t1"], b["t1"]) - max(a["t0"], b["t0"])
            if overlap <= 0.25:
                continue
            na, nb = norm(a["zh"]), norm(b["zh"])
            if not na or not nb:
                continue
            if a.get("pos") or b.get("pos"):
                continue
            if re.search(r"[0-9A-Za-z]", a["zh"] + b["zh"]):
                continue
            if sim(na, nb) >= 0.72 or (min(len(na), len(nb)) >= 4 and (na in nb or nb in na)):
                issues.append(dict(type="duplicate", severity="high", t=round(min(a["t0"], b["t0"]), 2),
                                   text="%s | %s" % (a["zh"], b["zh"]),
                                   detail="同一时间出现两条意思重复的字幕",
                                   advice="只保留一条，删掉重复的"))
                counts["duplicate"] += 1
    # 2) 半截句：相邻两条紧挨着、合并后语义才完整（OCR 逐行切碎的典型症状）
    frag_end = re.compile(r"(而|和|与|或|的|把|从|就|也|都|跟|给|让|被)$")
    ordered = [e for e in sorted(srt, key=lambda x: x["t0"]) if e.get("zh") and not e.get("pos")]
    for a, b in zip(ordered, ordered[1:]):
        gap = b["t0"] - a["t1"]
        if gap > 0.6:
            continue
        ta, tb = (a.get("zh") or "").replace(" ", ""), (b.get("zh") or "").replace(" ", "")
        if not ta or not tb:
            continue
        merged = len(ta) + len(tb)
        if frag_end.search(ta) and merged <= 24:
            issues.append(dict(type="half-sentence", severity="medium", t=round(a["t0"], 2),
                               text="%s + %s" % (a["zh"], b["zh"]),
                               detail="前一条停在虚词上，两条连起来才是一句",
                               advice="把这两条合并成一句完整的话"))
            counts["half"] += 1
        elif len(ta) <= 2 and not re.search(r"[0-9A-Za-z]", ta) and merged <= 20:
            issues.append(dict(type="half-sentence", severity="low", t=round(a["t0"], 2),
                               text="%s + %s" % (a["zh"], b["zh"]),
                               detail="前一条只有 %d 个字，是被切碎的碎片" % len(ta),
                               advice="和相邻行合并"))
            counts["half"] += 1
    # 3) 字号过小（显式 style 覆盖时检查）
    style = zh.get("style") or {}
    if isinstance(style, dict):
        fs = float(style.get("fontScale") or 1.0)
        if fs < 0.95:
            issues.append(dict(type="font-size", severity="medium", t=0, text="fontScale=%.2f" % fs,
                               detail="字幕字号被缩小，移动端会看不清",
                               advice="fontScale 提到 1.0 以上，必要时上移一行"))
            counts["font"] += 1
    return issues, counts


def check_masks(work, zh, events, duration, w=720, h=1280):
    """遮罩问题：盖住原字幕、面积过大、水印没盖全 —— 用户提过的打码问题。"""
    issues = []
    counts = Counter()
    masks = load(os.path.join(work, "extra_masks.json"), []) or []
    if not masks:
        return issues, counts
    # 原片字幕事件（大号、位于画面中下部、成句的文字）
    subs_ev = []
    for e in events:
        txt = str(e.get("text") or "")
        if len(re.sub(r"\s", "", txt)) < 4:
            continue
        if WM_WORD.search(txt):   # 水印本身就是要打码的，不算原片字幕
            continue
        ew = float(e["x1"]) - float(e["x0"])
        eh = float(e["y1"]) - float(e["y0"])
        if eh < 0.014 * h or ew < 0.12 * w:
            continue
        subs_ev.append(e)
    for m in masks:
        box = m.get("box") or {}
        try:
            mx0 = float(box["x"]) * w
            my0 = float(box["y"]) * h
            mx1 = (float(box["x"]) + float(box["w"])) * w
            my1 = (float(box["y"]) + float(box["h"])) * h
        except (KeyError, TypeError, ValueError):
            continue
        area = ((mx1 - mx0) * (my1 - my0)) / float(w * h)
        if area > 0.08:
            issues.append(dict(type="mask-too-large", severity="medium", t=round(float(m.get("t0") or 0), 2),
                               text="遮罩占画面 %.1f%%" % (area * 100),
                               detail="遮罩面积过大，会糊掉画面主体",
                               advice="只框住引流文字本身，别整片糊"))
            counts["mask_large"] += 1
        for e in subs_ev:
            if float(e["t1"]) < float(m.get("t0") or 0) or float(e["t0"]) > float(m.get("t1") or duration):
                continue
            ex0, ey0, ex1, ey1 = float(e["x0"]), float(e["y0"]), float(e["x1"]), float(e["y1"])
            ox = max(0.0, min(mx1, ex1) - max(mx0, ex0))
            oy = max(0.0, min(my1, ey1) - max(my0, ey0))
            if ox * oy <= 0:
                continue
            cover = (ox * oy) / max(1.0, (ex1 - ex0) * (ey1 - ey0))
            if cover >= 0.12:
                issues.append(dict(type="mask-on-subtitle", severity="high", t=round(max(float(e["t0"]), float(m.get("t0") or 0)), 2),
                                   text=str(e.get("text"))[:40],
                                   detail="遮罩盖住了原片字幕（覆盖 %.0f%%）" % (cover * 100),
                                   advice="把遮罩收窄或下移，避开原字幕行"))
                counts["mask_sub"] += 1
    # 水印遮罩：引流水印文字是否被完整覆盖
    wm_ev = []
    for e in events:
        txt = str(e.get("text") or "")
        if WM_WORD.search(txt):
            wm_ev.append(e)
    for e in wm_ev:
        cx = (float(e["x0"]) + float(e["x1"])) / 2.0 / w
        cy = (float(e["y0"]) + float(e["y1"])) / 2.0 / h
        covered = False
        for m in masks:
            box = m.get("box") or {}
            try:
                if (float(box["x"]) <= cx <= float(box["x"]) + float(box["w"])
                        and float(box["y"]) <= cy <= float(box["y"]) + float(box["h"])):
                    covered = True
                    break
            except (KeyError, TypeError, ValueError):
                continue
        if not covered:
            issues.append(dict(type="watermark-unmasked", severity="high", t=round(float(e["t0"]), 2),
                               text=txt[:40],
                               detail="引流水印没有被遮罩覆盖",
                               advice="补一块遮罩盖住这个水印"))
            counts["wm_unmasked"] += 1
    return issues, counts


def check_end_card(events, zh, duration):
    """片尾订阅/关注引导卡：应该直接剪掉，不要留在成片里。"""
    issues = []
    counts = Counter()
    if duration <= 0:
        return issues, counts
    tail = [e for e in events if duration - 5.0 <= float(e["t0"]) < duration - 0.15]
    for e in tail:
        txt = str(e.get("text") or "")
        if CTA_TAIL.search(txt) or CTA_TAIL_EN.search(txt):
            issues.append(dict(type="end-card", severity="high", t=round(float(e["t0"]), 2),
                               text=txt[:40],
                               detail="片尾有订阅/关注引导卡",
                               advice="直接剪掉这段，不要打码也不要翻译"))
            counts["endcard"] += 1
            break
    return issues, counts


def check_crop_output(video, probe):
    """裁切后比例是否仍是原片比例（用户要求等比裁切）。"""
    issues = []
    counts = Counter()
    out = run_ffprobe(video)
    if not out:
        return issues, counts
    try:
        ow, oh = int(out["width"]), int(out["height"])
        pw, ph = int(probe.get("width") or ow), int(probe.get("height") or oh)
    except (TypeError, ValueError):
        return issues, counts
    if not oh or not ph:
        return issues, counts
    if abs((ow / float(oh)) - (pw / float(ph))) > 0.02:
        issues.append(dict(type="crop-aspect", severity="high", t=0,
                           text="%dx%d → %dx%d" % (pw, ph, ow, oh),
                           detail="成片比例和原片不一致，画面会被拉变形",
                           advice="裁切后按原比例补齐，再等比缩放"))
        counts["crop"] += 1
    return issues, counts


def run_ffprobe(video):
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-of", "json", video],
                           capture_output=True, text=True, timeout=30)
        data = json.loads(p.stdout or "{}")
        st = (data.get("streams") or [{}])[0]
        return {"width": st.get("width"), "height": st.get("height")}
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default=os.path.join(HERE, "bin", "ffmpeg"))
    ap.add_argument("--ocr", default=os.path.join(HERE, "bin", "ocrmix"))
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--width", type=int, default=540)
    args = ap.parse_args()

    work = args.work
    probe = load(os.path.join(work, "probe.json"), {}) or {}
    events = load(os.path.join(work, "events.json"), []) or []
    asr = load(os.path.join(work, "asr.json"), {}) or {}
    zh = load(os.path.join(work, "zh.json"), {}) or {}
    duration = float(zh.get("duration") or probe.get("duration") or 0.0)
    folder = "%d 已完成" % args.index
    folder_dir = os.path.join(args.out, folder)
    video = os.path.join(work, "rendered.mp4")
    if os.path.isdir(folder_dir):
        meta = load(os.path.join(folder_dir, "meta.json"), {}) or {}
        if meta.get("video"):
            candidate = os.path.join(folder_dir, meta["video"])
            if os.path.exists(candidate):
                video = candidate
    if not os.path.exists(video):
        raise SystemExit("找不到成片")

    issues = []
    counts = Counter()

    progress(0.1, "qc", "抽帧复检画面")
    frames, sampled = ocr_frames(args.ffmpeg, args.ocr, video, work, args.fps, args.width)
    translated = set()
    for key, value in (zh.get("overlays") or {}).items():
        if isinstance(value, str) and value.strip():
            translated.add(norm(value))
    for e in events:
        if str(e["id"]) in {str(k) for k in (zh.get("overlays") or {})}:
            translated.add(norm(e["text"]))
    frame_issues, frame_counts = check(frames, duration, translated)
    issues.extend(frame_issues)
    counts.update(frame_counts)
    progress(0.5, "qc", "%d 帧 / 价格类 %d · 水印 %d" % (sampled, counts["promo"], counts["watermark"]))

    srt = parse_srt(os.path.join(folder_dir, "中外对照字幕.srt"))
    overlays = {str(k): v for k, v in (zh.get("overlays") or {}).items()}
    drops = set(str(int(x)) for x in (zh.get("drop") or []))
    promos = set(str(int(x)) for x in (zh.get("promo") or []))
    segments = (asr.get("segments") or []) if asr.get("ok") else []

    # 2b) 成片里仍无中文字幕的画面外文（原始事件表没抓到的漏译）
    def covered_time(t):
        return any(e["t0"] - 0.8 <= t <= e["t1"] + 0.8 for e in srt)

    bursts = {}
    for f in frames:
        if covered_time(f["t"]):
            continue
        big_lines = [it for it in f["items"]
                     if FOREIGN.search(it["text"]) and float(it.get("h") or 0) >= 0.02]
        # 漫画页/海报整屏文字：不是字幕，跳过（避免把整页对白当漏译）
        if len(big_lines) >= 4:
            continue
        for it in f["items"]:
            text = it["text"]
            if not FOREIGN.search(text) or len(re.sub(r"\s", "", text)) < 4:
                continue
            if it.get("c", 0) < 0.3:
                continue
            # 只盯「像字幕」的文字：足够大，或较大且位于画面下半部
            hh = float(it.get("h") or 0)
            yy = float(it.get("y") or 0)
            if not (hh >= 0.022 or (hh >= 0.015 and yy >= 0.42)):
                continue
            key = norm(text)
            if not key:
                continue
            entry = bursts.setdefault(key, {"text": text, "t0": f["t"], "t1": f["t"],
                                            "y": it["y"], "h": it["h"], "n": 0})
            entry["t0"] = min(entry["t0"], f["t"])
            entry["t1"] = max(entry["t1"], f["t"])
            entry["n"] += 1

    uncovered = [v for v in bursts.values() if v["n"] >= 1]
    uncovered.sort(key=lambda v: v["t0"])
    for v in uncovered[:30]:
        issues.append(dict(
            type="untranslated-ocr", severity="high", t=round(v["t0"], 2),
            t1=round(min(duration, v["t1"] + 1.0), 2), text=v["text"],
            detail="成片里这段画面外文没有中文字幕",
            advice="补一条字幕并重烧",
            box=dict(x=0.0, y=v["y"], w=1.0, h=max(0.02, v["h"])),
        ))
    counts["uncovered"] = len(uncovered)

    # 3) 覆盖：画面外文与口播都要有中文字幕
    def covered(text, t0, t1):
        for e in srt:
            if e["t1"] < t0 - 0.6 or e["t0"] > t1 + 0.6:
                continue
            if sim(norm(e["src"]), norm(text)) >= 0.55 or sim(norm(e["zh"]), norm(text)) >= 0.55:
                return True
        return False

    missing = []
    zh_overlays = {str(k) for k in (zh.get("overlays") or {})}
    speech_keys = set()
    for key in (zh.get("speech") or {}):
        k = str(key)
        speech_keys.add(k[1:] if k.startswith("s") else k)
    translated_events = [e for e in events if str(e["id"]) in zh_overlays]

    def covered_by_neighbor(ev):
        key = norm(ev["text"])
        for other in translated_events:
            if abs(other["t0"] - ev["t0"]) > 4.0:
                continue
            if sim(norm(other["text"]), key) >= 0.6:
                return True
        return False

    sub_spans = []
    for x in (zh.get("extra_subs") or []):
        try:
            sub_spans.append((float(x.get("t0")), float(x.get("t1"))))
        except (TypeError, ValueError):
            pass

    def covered_by_extra(ev):
        mid = (float(ev["t0"]) + float(ev["t1"])) / 2.0
        return any(a - 0.05 <= mid <= b + 0.05 for a, b in sub_spans)

    for ev in events:
        eid = str(ev["id"])
        if eid in promos or eid in drops or eid in zh_overlays:
            continue
        if covered_by_extra(ev):
            continue
        if not FOREIGN.search(ev["text"]) or len(re.sub(r"\s", "", ev["text"])) < 5:
            continue
        # 纯拉丁字母（品牌名/水印/包装英文）按规则保留原文，不算漏译
        if not re.search(r"[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]", ev["text"]):
            continue
        # 纯片假名/短品牌名（logo 屏上的品牌字样，如 アベンヌ）保留原文，不算漏译
        t2 = re.sub(r"\s", "", ev["text"])
        if len(t2) <= 8 and re.fullmatch(r"[\u30a0-\u30ffー・]+", t2):
            continue
        if ev["h"] < 24 or ev["n"] < 2:
            continue
        if covered_by_neighbor(ev):
            continue
        missing.append(dict(type="missing-translation", severity="high", t=round(ev["t0"], 2),
                            id=ev["id"], text=ev["text"], detail="画面文字没有对应中文字幕",
                            advice="补译这条并重新烧录"))
    # 画面本身已有足够字幕时，口播字幕是被主动省略的，不算漏译
    overlay_spans = [(e["t0"], e["t1"]) for e in srt if e.get("src")]
    cov = 0.0
    if duration > 0 and overlay_spans:
        merged = []
        for a, b in sorted(overlay_spans):
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        cov = sum(b - a for a, b in merged) / duration
    if cov < 0.55:
        for i, seg in enumerate(segments):
            if str(i) in speech_keys:
                continue
            missing.append(dict(type="missing-speech", severity="medium", t=round(seg["t0"], 2),
                                text=seg["text"], detail="口播没有对应中文字幕",
                                advice="补译这句口播"))
    issues.extend(missing[:60])
    counts["missing"] = len(missing)
    progress(0.72, "qc", "覆盖检查：漏译 %d 处" % len(missing))

    # 4) 字幕规范
    style = 0
    for e in srt:
        zh_text = e["zh"]
        if not zh_text:
            counts["style"] += 1
            style += 1
            continue
        if "\n" in zh_text:
            issues.append(dict(type="style", severity="low", t=round(e["t0"], 2), text=zh_text,
                               detail="字幕出现换行", advice="压成单行"))
            style += 1
        elif COVER.search(zh_text):
            issues.append(dict(type="style", severity="low", t=round(e["t0"], 2), text=zh_text,
                               detail="字幕含标点", advice="去掉标点"))
            style += 1
        elif len(zh_text) > 26:
            issues.append(dict(type="style", severity="low", t=round(e["t0"], 2), text=zh_text,
                               detail="字幕过长（%d 字）" % len(zh_text), advice="精简到 20 字以内"))
            style += 1
        if e["t1"] - e["t0"] < 0.45:
            issues.append(dict(type="timing", severity="low", t=round(e["t0"], 2), text=zh_text,
                               detail="停留时间过短（%.2fs）" % (e["t1"] - e["t0"]), advice="延长或合并"))
            counts["timing"] += 1
    counts["style"] = style

    # 4b) 字幕质量：重复 / 半句 / 字号
    sub_issues, sub_counts = check_subtitle_quality(srt, zh, duration)
    issues.extend(sub_issues); counts.update(sub_counts)

    # 4c) 遮罩质量：盖字幕 / 过大 / 水印没盖全
    mask_issues, mask_counts = check_masks(work, zh, events, duration)
    issues.extend(mask_issues); counts.update(mask_counts)

    # 4d) 片尾引流卡
    end_issues, end_counts = check_end_card(events, zh, duration)
    issues.extend(end_issues); counts.update(end_counts)

    # 4e) 输出比例
    crop_issues, crop_counts = check_crop_output(video, probe)
    issues.extend(crop_issues); counts.update(crop_counts)

    # 5) 文案合规：品牌必现、禁用 AI 水文案、潮玩只收泡泡玛特
    title = str(zh.get("title") or "")
    body = str(zh.get("body") or "")
    brand = str(zh.get("brand") or "").strip()
    vertical = str(zh.get("vertical") or "")
    BANNED = re.compile(r"太炫酷|天下豪车|绝绝子|无敌了|谁懂啊|闭眼入|爱了爱了|太顶了|好看到爆|绝美|炸裂|必入|无脑入")
    if BANNED.search(title + body):
        issues.append(dict(type="copy", severity="medium", t=0, text=BANNED.search(title + body).group(0),
                           detail="标题或正文含模板化水文案", advice="改成具体卖点/型号"))
    if brand and brand not in title:
        issues.append(dict(type="brand", severity="medium", t=0, text=brand,
                           detail="标题没有出现品牌名", advice="标题补上品牌"))
    if "潮玩" in vertical and not re.search(r"pop\s*mart|泡泡玛特", title + body + brand, re.I):
        issues.append(dict(type="acceptance", severity="high", t=0, text=brand or title,
                           detail="潮玩类只接受泡泡玛特，本条不符合", advice="按投放标准不出片"))

    high = sum(1 for i in issues if i["severity"] == "high")
    mid = sum(1 for i in issues if i["severity"] == "medium")
    verdict = "fail" if high else ("warn" if mid else "pass")
    result = dict(
        index=args.index, verdict=verdict, duration=round(duration, 2),
        sampledFrames=sampled, issues=issues,
        counts={k: counts[k] for k in ("promo", "watermark", "missing", "uncovered", "style", "timing")},
        checkedAt=__import__("time").strftime("%Y-%m-%dT%H:%M:%S"),
    )
    with open(os.path.join(work, "qc.json"), "w") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    progress(1.0, "qc", "%s：%d 个问题" % (verdict, len(issues)))
    log("QC_OK %s" % json.dumps({
        "index": args.index, "verdict": verdict, "counts": result["counts"],
        "issues": len(issues), "top": [i["detail"] for i in issues[:5]],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
