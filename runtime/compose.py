#!/usr/bin/env python3
"""Stage 2 — 依据翻译结果合成成品：抹除引流 / 烧录单行中文字幕 / 封面 / 字幕文件 / 成品文件夹。

用法:
  python3 compose.py --work <workdir> --index 3 --out <batchDir> [--ffmpeg path] [--font path]
                     [--title 覆盖标题] [--max-chars 26]

依赖 workdir 中的 probe.json / events.json / asr.json / zh.json（翻译结果）。
产物: <batchDir>/<index> 已完成/ 下的视频、封面、中文字幕、中外对照字幕、文案.txt、meta.json
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
PUNCT = re.compile(
    r"[\u3000-\u303f\uff01-\uff5e\u2010-\u2027\u2030-\u205e`~!@#$%^&*()+=\[\]{}\\|;:'\",.<>/?]")
PRICE = re.compile(
    r"(?:[¥￥$€£]\s?\d[\d,\.]*|\d[\d,\.]*\s?(?:円|원|元|日元|美元|块|万韩元|韩元|美元|美元)"
    r"|\d+\s?[%％]\s*(?:off|OFF|折扣|할인)|\d+\s?折|(?:原价|售价|到手价|券后|限时价|特价)\s?\d*"
    r"|\d+\s?[.,]\s?\d+\s?[円원元])")
CTA = re.compile(
    r"(?:关注|点赞|订阅|收藏|转发|评论|私信|链接|主页|店铺|小黄车|购物车|优惠券|下单|购买|抢购|"
    r"follow\s*me|subscribe|link\s*in\s*bio|dm\s*me|shop\s*now|click\s*the\s*link|"
    r"看简介|简介|橱窗|团购)", re.I)
# 片尾订阅/关注引导（这类卡片直接剪掉，不要翻译或打码）
CTA_TAIL = re.compile(
    r"(구독|좋아요|알림|팔로우|팔로워|댓글|공유|채널|订阅|关注|点赞|转发|收藏|评论|一键三连|小铃铛)"
)
CTA_TAIL_EN = re.compile(r"(subscribe|like\s+and|follow\s+me|click\s+the\s+bell|notification)", re.I)
# 引流水印/频道标记
WM_WORD = re.compile(r"(마카세|도마|동찌|omakase|dongzzi|makase)", re.I)
PROMO = re.compile(
    r"(?:[¥￥$€£]\s?\d|\d[\d,\.]*\s?(?:円|원|元|日元|美元)"
    r"|인스타|인스타그램|유튜브|틱톡|블로그|팔로우|좋아요|구독|댓글|공유|저장|링크|프로필|디엠|광고|협찬|제품제공|브랜드|이벤트|출시"
    r"|instagram|insta\b|youtube|youtu\.be|tiktok|twitter|threads|snapchat|facebook|"
    r"follow\s*(?:me|us)|subscribe|like\s*(?:and|&|this)|comment\s*below|share\s*this|save\s*this|"
    r"link\s*in\s*bio|dm\s*(?:me|us)|#ad\b|#sponsored|#pr\b|#협찬|#광고|"
    r"小红书|抖音|微博|哔哩|b站|视频号|公众号|关注我|点赞|收藏|转发|评论区|私信|加微|合作"
    r"|關注|按讚|訂閱|"
    r"\d+\s?[%％]\s*(?:off|할인|할인율|折扣|优惠)|off|discount|sale|coupon|"
    r"follow|subscribe|like\b|comment|link|bio|@[A-Za-z0-9_.]{2,}|https?://|www\.|"
    r"좋아요|구독|팔로우|댓글|저장|링크|프로필|구매|할인|쿠폰|정상가|최종|원\b|"
    r"关注|点赞|订阅|收藏|私信|链接|主页|店铺|优惠|打折|价格|下单|购买)", re.I)


def log(*a):
    print(*a, flush=True)


def progress(ratio, stage, message=""):
    log("PROGRESS %s %s %s" % (round(float(ratio), 3), stage, message))


def run(cmd, cwd=None, timeout=None):
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError("command failed (%s): %s\n%s" % (
            p.returncode, " ".join(cmd[:5]), (p.stderr or "")[-1500:]))
    return p


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)


def norm_key(s):
    return "".join(ch.lower() for ch in s if ch.isalnum())


def similarity(a, b):
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


def clean_zh(text, max_chars=26):
    """单行、无标点、去掉引流与价格。"""
    if not text:
        return ""
    s = str(text).replace("\n", " ").replace("\r", " ")
    s = PRICE.sub(" ", s)
    s = CTA.sub(" ", s)
    s = PUNCT.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if CJK.search(s):
        s = s.replace(" ", "")
    s = re.sub(r"[\uac00-\ud7af\u1100-\u11ff\u3040-\u30ff]+", "", s)
    s = s.strip()
    han = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", s))
    latin = len(re.findall(r"[A-Za-z]", s))
    if han == 0 and latin == 0:
        return ""
    if han < 2 and latin < 3:
        return ""
    if len(s) > max_chars:
        s = s[:max_chars].rstrip()
    return s


def ass_time(t):
    t = max(0.0, float(t))
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return "%d:%02d:%05.2f" % (h, m, s)


def srt_time(t):
    t = max(0.0, float(t))
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms >= 1000:
        ms -= 1000
        s += 1
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def width_weight(text):
    w = 0.0
    for ch in text:
        w += 1.0 if CJK.match(ch) else 0.56
    return max(1.0, w)


def font_size(text, max_width=720 - 72, lo=30, hi=48):
    fs = int(max_width / width_weight(text))
    return int(max(lo, min(hi, fs)))


def dedupe_map(events, segments):
    """OCR 与 ASR 结果一致时，只保留 OCR 那一条翻译。返回 {asrIndex: eventId}。"""
    mapping = {}
    for i, seg in enumerate(segments):
        key = norm_key(seg["text"])
        best_id, best_score = None, 0.0
        for e in events:
            overlap = min(e["t1"], seg["t1"]) - max(e["t0"], seg["t0"])
            if overlap <= 0.05:
                continue
            other = norm_key(e["text"])
            if not key or not other:
                continue
            # 只有「差不多等长且相似」才算结果一致；避免一个短片段顶掉整句
            short, long_ = sorted((len(key), len(other)))
            ratio = short / float(long_) if long_ else 0.0
            if short < 6 or ratio < 0.4:
                continue
            s = similarity(key, other)
            if s < 0.55:
                continue
            score = s + min(overlap, 1.5) / 10.0 + ratio / 10.0
            if score > best_score:
                best_id, best_score = e["id"], score
        if best_id is not None:
            mapping[i] = best_id
    return mapping


def is_product_english(text):
    """商品上的纯英文（品牌/型号/尺码）：不翻译，保留原文。"""
    t = str(text or "").strip()
    if not t or not re.fullmatch(r"[A-Za-z0-9\s&\-\+\.%/'\u00ae\u2122\u00a9]+", t):
        return False
    words = [w for w in re.split(r"\s+", t) if w]
    return len(words) <= 2 and len(t) <= 24


def is_caption(event, w, h):
    """判断这条文字是否像视频字幕/花字，而不是背景漫画、海报、页面里的装饰小字。"""
    eh = float(event.get("h") or 0)
    ew = float(event.get("x1", 0)) - float(event.get("x0", 0))
    cy = (float(event.get("y0", 0)) + float(event.get("y1", 0))) / 2.0
    if eh >= 0.018 * h:
        return True
    if eh >= 0.012 * h and cy >= 0.42 * h and ew >= 0.2 * w:
        return True
    if eh >= 0.010 * h and event.get("n", 0) >= 4 and ew >= 0.26 * w:
        return True
    return False


def build_cues(events, segments, zh, dedupe, max_chars):
    overlays = {str(k): v for k, v in (zh.get("overlays") or {}).items()}
    speech = {str(k): v for k, v in (zh.get("speech") or {}).items()}
    drops = set(int(x) for x in (zh.get("drop") or []))
    promo = set(int(x) for x in (zh.get("promo") or []))
    for e in events:
        if PROMO.search(e["text"]):
            promo.add(e["id"])
    used_events = set(dedupe.values())
    cues = []

    for i, seg in enumerate(segments):
        matched = dedupe.get(i)
        zh_text = None
        if matched is not None:
            # OCR 与 ASR 结果一致：以 OCR 为准，使用画面文字的译文
            zh_text = overlays.get(str(matched))
            if not zh_text and str(matched) in drops:
                zh_text = None
        if not zh_text:
            zh_text = speech.get("s%d" % i) or speech.get(str(i))
        zh_text = clean_zh(zh_text, max_chars)
        if not zh_text:
            continue
        cues.append(dict(t0=float(seg["t0"]), t1=float(seg["t1"]), zh=zh_text,
                         src=(seg.get("text") or "").strip(), kind="speech", ref=i))

    for extra in (zh.get("extra_subs") or []):
        try:
            text = clean_zh(extra.get("zh"), min(max_chars, 22))
            if not text:
                continue
            _pos = extra.get("pos") if isinstance(extra.get("pos"), dict) else None
            cues.append(dict(t0=float(extra["t0"]), t1=float(extra["t1"]), zh=text,
                             src=str(extra.get("src") or ""), kind="overlay",
                             ref=-1, y0=float(extra.get("y0") or 0), x0=0.0,
                             h=float(extra.get("h") or 40), n=3,
                             pos=_pos, en=str(extra.get("en") or "")))
        except (KeyError, TypeError, ValueError):
            continue

    for e in events:
        if e["id"] in used_events or e["id"] in drops or e["id"] in promo:
            continue
        if is_product_english(e["text"]):
            continue  # 商品英文保留原文，不翻译
        zh_text = clean_zh(overlays.get(str(e["id"])), min(max_chars, 22))
        if not zh_text:
            continue
        cues.append(dict(t0=float(e["t0"]), t1=float(e["t1"]), zh=zh_text,
                         src=e["text"].strip(), kind="overlay", ref=e["id"],
                         y0=float(e["y0"]), x0=float(e["x0"]),
                         h=float(e["h"]), n=int(e.get("n") or 0)))
    return cues, promo


def rotate_overlays(cues, duration, max_chars=22):
    """同一时刻的多条画面文字合并成一行（放不下就保留信息最多的那条），不再按时间轮播，保证时间对齐。"""
    group = sorted([c for c in cues if c["kind"] == "overlay"], key=lambda c: (c["t0"], c.get("y0", 0)))
    out = []
    for c in group:
        if isinstance(c.get("pos"), dict):
            out.append(c)
            continue
        if out and c["t0"] < out[-1]["t1"] - 0.01 and (c["t0"] - out[-1]["t0"]) <= 0.35:
            prev = out[-1]
            a, b = prev["zh"], c["zh"]
            if a and b and a[-1] == b[0]:
                b = b[1:]
            joined = (a + " " + b).strip()
            if len(joined) <= max_chars:
                prev["zh"] = joined
                prev["src"] = (prev.get("src", "") + " / " + c.get("src", "")).strip(" /")
                prev["t1"] = max(prev["t1"], c["t1"])
            elif len(c["zh"]) > len(prev["zh"]):
                prev["zh"] = c["zh"]
                prev["src"] = c.get("src", "")
                prev["t1"] = max(prev["t1"], c["t1"])
            continue
        if out and c["t0"] < out[-1]["t1"] - 0.01:
            prev = out[-1]
            prev["t1"] = min(prev["t1"], c["t0"] - 0.02)
            if prev["t1"] - prev["t0"] < 0.25:
                out.pop()
        out.append(c)
    return out


def span_coverage(spans, duration):
    if duration <= 0 or not spans:
        return 0.0
    spans = sorted(spans)
    total = 0.0
    cur_s = cur_e = None
    for a, b in spans:
        if cur_s is None:
            cur_s, cur_e = a, b
        elif a <= cur_e:
            cur_e = max(cur_e, b)
        else:
            total += max(0.0, cur_e - cur_s)
            cur_s, cur_e = a, b
    if cur_s is not None:
        total += max(0.0, cur_e - cur_s)
    return min(1.0, total / duration)


def merge_cross_tier(cues, threshold=0.45):
    """口播与画面文字在同一时刻内容差不多时，只保留 OCR（画面文字）那条，避免两行重复。"""
    speech = [c for c in cues if c["kind"] == "speech"]
    overlays = [c for c in cues if c["kind"] == "overlay"]
    drop = set()
    for s in speech:
        s_key = norm_key(s["zh"])
        for o in overlays:
            if s["t1"] < o["t0"] - 0.2 or s["t0"] > o["t1"] + 0.2:
                continue
            o_key = norm_key(o["zh"])
            if not s_key or not o_key:
                continue
            sim = similarity(s_key, o_key)
            contained = min(len(s_key), len(o_key)) >= 4 and (s_key in o_key or o_key in s_key)
            if sim >= threshold or contained:
                drop.add(id(s))
                break
    if drop:
        return [c for c in cues if id(c) not in drop]
    return cues


def settle_cues(cues, duration):
    """两条轨独立处理：口播字幕在下面，画面文字译文在上面，互不挤占。"""
    result = rotate_overlays(cues, duration)
    for kind in ("speech",):
        group = sorted([c for c in cues if c["kind"] == kind], key=lambda c: c["t0"])
        out = []
        for c in group:
            c["t0"] = max(0.0, min(c["t0"], max(0.0, duration - 0.4)))
            c["t1"] = max(c["t0"] + 0.5, min(c["t1"], duration))
            if out and c["t0"] < out[-1]["t1"] - 0.01:
                prev = out[-1]
                if prev["zh"] == c["zh"]:
                    prev["t1"] = max(prev["t1"], c["t1"])
                    continue
                prev["t1"] = min(prev["t1"], c["t0"] - 0.02)
                if prev["t1"] - prev["t0"] < 0.3:
                    out.pop()
            out.append(c)
        for c in out:
            if c["t1"] - c["t0"] >= 0.3 and c["t0"] < duration:
                result.append(c)
    result.sort(key=lambda c: (c["t0"], 0 if c["kind"] == "speech" else 1))
    return result


def is_obvious_price(e, w, h):
    """价格是否明显到需要处理：字号够大或宽度够醒目；包装上的微小印字不处理。"""
    eh = float(e.get("h") or 0)
    ew = float(e.get("x1", 0)) - float(e.get("x0", 0))
    return eh >= 0.018 * h or ew >= 0.18 * w


def promo_boxes(events, promo_ids, w, h):
    boxes = []
    for e in events:
        if e["id"] not in promo_ids:
            continue
        if PRICE.search(str(e.get("text") or "")) and not is_obvious_price(e, w, h):
            continue  # 不明显的小价格：不打码
        pad = 10
        x0 = max(0, int(e["x0"]) - pad)
        y0 = max(0, int(e["y0"]) - pad)
        x1 = min(w, int(e["x1"]) + pad)
        y1 = min(h, int(e["y1"]) + pad)
        if x1 - x0 < 12 or y1 - y0 < 10:
            continue
        boxes.append(dict(x0=x0, y0=y0, x1=x1, y1=y1,
                          t0=max(0.0, e["t0"] - 0.25), t1=e["t1"] + 0.35))
    boxes.sort(key=lambda b: (b["t0"], b["y0"]))
    # 同一时段的相邻框合并成一个，避免叠一堆滤镜
    merged = []
    for b in boxes:
        hit = None
        for m in merged:
            if b["t0"] < m["t1"] + 0.2 and b["t1"] > m["t0"] - 0.2:
                near_x = b["x0"] < m["x1"] + 70 and b["x1"] > m["x0"] - 70
                near_y = b["y0"] < m["y1"] + 70 and b["y1"] > m["y0"] - 70
                if near_x and near_y:
                    hit = m
                    break
        if hit is None:
            merged.append(dict(b))
        else:
            hit["x0"] = min(hit["x0"], b["x0"])
            hit["y0"] = min(hit["y0"], b["y0"])
            hit["x1"] = max(hit["x1"], b["x1"])
            hit["y1"] = max(hit["y1"], b["y1"])
            hit["t0"] = min(hit["t0"], b["t0"])
            hit["t1"] = max(hit["t1"], b["t1"])
    # 去掉被完全覆盖的框
    keep = []
    for i, b in enumerate(merged):
        covered = False
        for j, o in enumerate(merged):
            if i == j:
                continue
            if (o["x0"] <= b["x0"] and o["y0"] <= b["y0"] and o["x1"] >= b["x1"]
                    and o["y1"] >= b["y1"] and o["t0"] <= b["t0"] and o["t1"] >= b["t1"]
                    and (o["x1"] - o["x0"]) * (o["y1"] - o["y0"]) > (b["x1"] - b["x0"]) * (b["y1"] - b["y0"])):
                covered = True
                break
        if not covered:
            keep.append(b)
    keep.sort(key=lambda b: b["t0"])
    # 电商卡片：把同一时段、紧邻的小字行吸进同一个遮罩，整块抹掉
    for _ in range(2):
        for b in keep:
            for e in events:
                if e["t1"] < b["t0"] or e["t0"] > b["t1"]:
                    continue
                ew, eh = e["x1"] - e["x0"], e["y1"] - e["y0"]
                if ew > 320 or eh > 90:
                    continue
                if e["x1"] < b["x0"] - 28 or e["x0"] > b["x1"] + 28:
                    continue
                if e["y1"] < b["y0"] - 28 or e["y0"] > b["y1"] + 28:
                    continue
                nx0 = max(0, min(b["x0"], int(e["x0"]) - 10))
                ny0 = max(0, min(b["y0"], int(e["y0"]) - 10))
                nx1 = min(w, max(b["x1"], int(e["x1"]) + 10))
                ny1 = min(h, max(b["y1"], int(e["y1"]) + 10))
                if nx1 - nx0 > 330 or ny1 - ny0 > 300:
                    continue
                b["x0"], b["y0"], b["x1"], b["y1"] = nx0, ny0, nx1, ny1
    return keep


def ass_document(cues, w, h, style=None):
    scale = max(0.5, float(w) / 720.0)
    style = style or {}
    scale = scale * float(style.get("fontScale") or 1.0)
    margin_v = int(round(float(style.get("marginV") or 92) * max(0.5, float(w) / 720.0)))
    head = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: %d" % w,
        "PlayResY: %d" % h,
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: zh,Noto Sans SC,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,"
        "100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % (
            int(round(44 * scale)), 3.2 * scale, int(round(36 * scale)),
            int(round(36 * scale)), margin_v),
        "Style: en,Noto Sans SC,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,"
        "100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % (
            int(round(34 * scale)), 2.8 * scale, int(round(36 * scale)),
            int(round(36 * scale)), margin_v + int(round(62 * scale))),
        "Style: oi,Noto Sans SC,%d,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,"
        "100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % (
            int(round(38 * scale)), 3.0 * scale, int(round(36 * scale)),
            int(round(36 * scale)), margin_v + int(round(74 * scale))),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    body = []
    for c in cues:
        text = c["zh"].replace("{", "(").replace("}", ")")
        if c["kind"] == "speech":
            style, lo, hi = "zh", 30, 48
        else:
            style, lo, hi = "oi", 26, 38
        fs = font_size(text, max_width=int(w) - int(round(72 * scale)),
                       lo=int(round(lo * scale)), hi=int(round(hi * scale)))
        pos = c.get("pos")
        if isinstance(pos, dict) and pos.get("x") is not None and pos.get("y") is not None:
            pfs = max(14, int(fs * 0.62))
            body.append("Dialogue: 0,%s,%s,%s,,0,0,0,,{\\an5\\pos(%d,%d)\\fs%d}%s" % (
                ass_time(c["t0"]), ass_time(c["t1"]), style,
                int(float(pos["x"]) * w), int(float(pos["y"]) * h), pfs, text))
        else:
            body.append("Dialogue: 0,%s,%s,%s,,0,0,0,,{\\fs%d}%s" % (
                ass_time(c["t0"]), ass_time(c["t1"]), style, fs, text))
        en = (c.get("en") or "").strip()
        if en and not (isinstance(c.get("pos"), dict)):
            en = en.replace("{", "(").replace("}", ")")
            efs = font_size(en, max_width=int(w) - int(round(72 * scale)),
                            lo=int(round(22 * scale)), hi=int(round(34 * scale)))
            body.append("Dialogue: 0,%s,%s,en,,0,0,0,,{\\fs%d}%s" % (
                ass_time(c["t0"]), ass_time(c["t1"]), efs, en))
    return "\n".join(head + body) + "\n"


def write_srt(path, cues, bilingual):
    lines = []
    for i, c in enumerate(cues, 1):
        lines.append(str(i))
        lines.append("%s --> %s" % (srt_time(c["t0"]), srt_time(c["t1"])))
        if bilingual and c.get("src"):
            lines.append(c["src"])
        lines.append(c["zh"])
        lines.append("")
    with open(path, "w") as fh:
        fh.write("\n".join(lines))


def esc_filter_path(p):
    return p.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def plan_crop(boxes, w, h, margin=0.09, max_frac=0.06):
    """边缘处的引流信息优先裁掉（比打码美观）；宽条引流（长文案）连上下带一起裁掉。"""
    cx0, cy0, cx1, cy1 = 0.0, 0.0, float(w), float(h)
    for b in boxes:
        wide = (b["x1"] - b["x0"]) >= 0.45 * w
        if not wide:
            continue
        if b["y1"] <= 0.12 * h:
            cy0 = max(cy0, float(b["y1"]) + 2)
        elif b["y0"] >= 0.88 * h:
            cy1 = min(cy1, float(b["y0"]) - 2)
    if cy1 - cy0 < 0.6 * h:
        cy0, cy1 = 0.0, float(h)
    for b in boxes:
        if b["x1"] <= margin * w and b["x0"] <= margin * w:
            cx0 = max(cx0, float(b["x1"]) + 2)
        if b["x0"] >= (1 - margin) * w and b["x1"] >= (1 - margin) * w:
            cx1 = min(cx1, float(b["x0"]) - 2)
        if b["y1"] <= margin * h and b["y0"] <= margin * h:
            cy0 = max(cy0, float(b["y1"]) + 2)
    cx0 = min(cx0, max_frac * w)
    cx1 = max(cx1, (1 - max_frac) * w)
    cy0 = min(cy0, max_frac * h)
    if cx1 - cx0 < 0.6 * w or cy1 - cy0 < 0.6 * h:
        return None
    # 按比例裁切：裁完的长宽比必须和原片一致，否则画面会被拉扁/拉长
    cw, ch = cx1 - cx0, cy1 - cy0
    target = float(w) / float(h)
    if cw / ch > target:
        nw = ch * target
        cx0 = cx0 + (cw - nw) / 2.0
        cx1 = cx0 + nw
    else:
        nh = cw / target
        cy0 = cy0 + (ch - nh) / 2.0
        cy1 = cy0 + nh
    cx0 = max(0.0, cx0); cy0 = max(0.0, cy0)
    cx1 = min(float(w), cx1); cy1 = min(float(h), cy1)
    if cx0 == 0.0 and cx1 == float(w) and cy0 == 0.0 and cy1 == float(h):
        return None
    return (int(cx0), int(cy0), int(cx1), int(cy1))


def apply_crop(boxes, crop, w, h):
    x0, y0, x1, y1 = crop
    cw, ch = max(1, x1 - x0), max(1, y1 - y0)
    fx, fy = w / float(cw), h / float(ch)
    out = []
    for b in boxes:
        nb = dict(b)
        nb["x0"] = int((float(b["x0"]) - x0) * fx)
        nb["x1"] = int((float(b["x1"]) - x0) * fx)
        nb["y0"] = int((float(b["y0"]) - y0) * fy)
        nb["y1"] = int((float(b["y1"]) - y0) * fy)
        if nb["x1"] <= 0 or nb["y1"] <= 0 or nb["x0"] >= w or nb["y0"] >= h:
            continue
        nb["x0"] = max(0, nb["x0"]); nb["y0"] = max(0, nb["y0"])
        nb["x1"] = min(w, nb["x1"]); nb["y1"] = min(h, nb["y1"])
        if nb["x1"] - nb["x0"] >= 10 and nb["y1"] - nb["y0"] >= 10:
            out.append(nb)
    return out


def build_filter(boxes, ass_path, fonts_dir, w, h, crop=None):
    parts = []
    if crop:
        cx0, cy0, cx1, cy1 = crop
        parts.append("[0:v]crop=%d:%d:%d:%d,scale=%d:%d[base]" % (cx1 - cx0, cy1 - cy0, cx0, cy0, w, h))
        cur = "base"
    else:
        cur = "0:v"
    for i, b in enumerate(boxes):
        x0 = max(0, min(int(b["x0"]), w - 16))
        y0 = max(0, min(int(b["y0"]), h - 16))
        bw = max(16, min(w - x0, int(b["x1"]) - x0))
        bh = max(16, min(h - y0, int(b["y1"]) - y0))
        bw -= bw % 2
        bh -= bh % 2
        nxt = "v%d" % (i + 1)
        parts.append("[%s]split=2[va%d][vb%d]" % (cur, i, i))
        parts.append("[vb%d]crop=%d:%d:%d:%d,gblur=sigma=12:steps=2[bz%d]" % (i, bw, bh, x0, y0, i))
        parts.append("[va%d][bz%d]overlay=%d:%d:enable='between(t,%.2f,%.2f)'[%s]" % (
            i, i, x0, y0, b["t0"], b["t1"], nxt))
        cur = nxt
    parts.append("[%s]subtitles=%s:fontsdir=%s[vout]" % (
        cur, esc_filter_path(ass_path), esc_filter_path(fonts_dir)))
    return ";".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default=os.path.join(HERE, "bin", "ffmpeg"))
    ap.add_argument("--font", default=os.path.join(HERE, "fonts", "NotoSansSC-Bold.ttf"))
    ap.add_argument("--fonts-dir", default=os.path.join(HERE, "fonts"))
    ap.add_argument("--title", default="")
    ap.add_argument("--body", default="")
    ap.add_argument("--max-chars", type=int, default=26)
    ap.add_argument("--asr-policy", default="never", choices=("auto", "always", "never"),
                    help="auto: 画面已有足够字幕时不烧口播字幕；always: 始终保留；never: 从不保留")
    ap.add_argument("--text-scope", default="important", choices=("all", "important"),
                    help="all=所有文字都翻译（商品英文除外）；important=只翻像字幕的文字")
    ap.add_argument("--no-edge-crop", action="store_true",
                    help="关闭边缘裁切（默认把边缘引流信息裁掉而不是打码）")
    ap.add_argument("--no-folder", action="store_true",
                    help="只渲染到 work 目录（稍后由 deliver.py 按顺序归档）")
    args = ap.parse_args()

    work = args.work
    probe = load_json(os.path.join(work, "probe.json"), {}) or {}
    events = load_json(os.path.join(work, "events.json"), []) or []
    asr = load_json(os.path.join(work, "asr.json"), {}) or {}
    zh = load_json(os.path.join(work, "zh.json"), {}) or {}
    segments = (asr.get("segments") or []) if asr.get("ok") else []

    duration = float(zh.get("duration") or probe.get("duration") or 0.0)
    w = int(probe.get("width") or 720)
    h = int(probe.get("height") or 1280)
    title = clean_zh(args.title or zh.get("title") or "", 24) or ("视频 %d" % args.index)
    body = clean_zh(args.body or zh.get("body") or "", 60)
    vertical = str(zh.get("vertical") or "").strip()

    if len(body) > 38:
        cut = body[:38]
        # 在空格/标点处断，避免文案停在半个词或半句上
        idx = max(cut.rfind(" "), cut.rfind("，"), cut.rfind("、"))
        if idx >= 24:
            cut = cut[:idx]
        body = cut.rstrip()

    # 先按「画面字幕覆盖率」决定是否要口播；不要口播时也不做 OCR/ASR 去重，
    # 否则被判为「与口播重复」的画面文字会连译文一起消失（这是之前的漏译根因）
    cap_events = [e for e in events if is_caption(e, w, h)]
    overlay_cov = span_coverage([(e["t0"], e["t1"]) for e in cap_events], duration)
    if args.asr_policy == "never":
        keep_speech = False
    elif args.asr_policy == "auto" and overlay_cov >= 0.55:
        keep_speech = False
    else:
        keep_speech = True
    use_segments = segments if keep_speech else []
    dedupe = dedupe_map(events, use_segments) if use_segments else {}
    cues, promo = build_cues(events, use_segments, zh, dedupe, args.max_chars)
    boxes = promo_boxes(events, promo, w, h)
    # 原片字幕区域：遮罩要避开，别把观众要看的字幕糊掉
    sub_boxes = []
    for e in events:
        txt = str(e.get("text") or "")
        if len(re.sub(r"\s", "", txt)) < 4 or WM_WORD.search(txt):
            continue
        if (float(e["y1"]) - float(e["y0"])) < 0.014 * h:
            continue
        sub_boxes.append((float(e["x0"]), float(e["y0"]), float(e["x1"]), float(e["y1"]), float(e["t0"]), float(e["t1"])))

    def shrink_off_subtitles(x0, y0, x1, y1, t0, t1):
        """把遮罩压到不碰原片字幕：优先裁上边，其次裁下边。"""
        for _ in range(3):
            hit = None
            for (sx0, sy0, sx1, sy1, st0, st1) in sub_boxes:
                if st1 < t0 - 0.2 or st0 > t1 + 0.2:
                    continue
                ox = max(0.0, min(x1, sx1) - max(x0, sx0))
                oy = max(0.0, min(y1, sy1) - max(y0, sy0))
                area = (sx1 - sx0) * (sy1 - sy0)
                if area > 0 and (ox * oy) / area >= 0.1:
                    hit = (sx0, sy0, sx1, sy1)
                    break
            if not hit:
                break
            sx0, sy0, sx1, sy1 = hit
            if sy0 > y0 and sy0 - y0 >= 10:
                y1 = min(y1, sy0 - 4)      # 从上方让开
            elif sy1 < y1 and y1 - sy1 >= 10:
                y0 = max(y0, sy1 + 4)      # 从下方让开
            else:
                if sx0 > x0 and sx0 - x0 >= 10:
                    x1 = min(x1, sx0 - 4)
                elif sx1 < x1 and x1 - sx1 >= 10:
                    x0 = max(x0, sx1 + 4)
                else:
                    break
            if x1 - x0 < 20 or y1 - y0 < 12:
                return None
        return (x0, y0, x1, y1)

    # 质检后补的遮罩（extra_masks.json：归一化坐标 + 时间段）
    for m in load_json(os.path.join(work, "extra_masks.json"), []) or []:
        box = m.get("box") or {}
        try:
            x0 = max(0, int(float(box.get("x", 0)) * w) - 12)
            y0 = max(0, int(float(box.get("y", 0)) * h) - 12)
            x1 = min(w, int((float(box.get("x", 0)) + float(box.get("w", 0.05))) * w) + 12)
            y1 = min(h, int((float(box.get("y", 0)) + float(box.get("h", 0.03))) * h) + 12)
            if x1 - x0 >= 12 and y1 - y0 >= 10:
                shrunk = shrink_off_subtitles(x0, y0, x1, y1,
                                              float(m.get("t0") or 0), float(m.get("t1") or duration))
                if shrunk is None:
                    progress(0.62, "mask", "遮罩与原字幕冲突且无法收缩，跳过 %d,%d-%d,%d" % (x0, y0, x1, y1))
                    continue
                sx0, sy0, sx1, sy1 = shrunk
                # 单片遮罩面积不超过画面 8%，太大就说明框错了
                if (sx1 - sx0) * (sy1 - sy0) > 0.08 * w * h:
                    cx, cy = (sx0 + sx1) // 2, (sy0 + sy1) // 2
                    half = int((0.08 * w * h) ** 0.5 / 2)
                    sx0, sx1 = max(0, cx - half), min(w, cx + half)
                    sy0, sy1 = max(0, cy - half // 2), min(h, cy + half // 2)
                boxes.append(dict(x0=sx0, y0=sy0, x1=sx1, y1=sy1,
                                  t0=float(m.get("t0") or 0), t1=float(m.get("t1") or duration)))
        except (TypeError, ValueError):
            continue
    # 自动水印：顶部/底部同一位置长期出现的文字（博主水印、logo 字样）
    wm = {}
    for e in events:
        key = "%s|%d|%d" % (norm_key(str(e["text"])), int(float(e["x0"]) / 40), int(float(e["y0"]) / 40))
        wm.setdefault(key, []).append(e)
    caption_texts = {norm_key(str(e["text"])) for e in events if str(e["id"]) in (zh.get("overlays") or {})}
    for key, evs in wm.items():
        span = sum(float(x["t1"]) - float(x["t0"]) for x in evs)
        # 常驻水印：必须占到大半时长，且不是已翻译的字幕
        if span < max(3.0, 0.6 * max(1.0, duration)):
            continue
        if any(norm_key(str(x["text"])) in caption_texts for x in evs):
            continue
        if len(str(evs[0]["text"])) > 24:
            continue
        ys = [(float(x["y0"]) + float(x["y1"])) / 2.0 for x in evs]
        xs = [(float(x["x0"]) + float(x["x1"])) / 2.0 for x in evs]
        # 只有贴着画面上下边缘的常驻小字才算水印（画面中部的固定字多是原片字幕，不能打码）
        cy = sum(ys) / max(1, len(ys))
        if not (cy < 0.12 * h or cy > 0.88 * h):
            continue
        # 位置稳定且字号偏小：视为常驻水印/博主信息/平台标识
        if max(xs) - min(xs) > 0.12 * w or max(ys) - min(ys) > 0.12 * h:
            continue
        if any(float(x["h"]) > 0.03 * h for x in evs):
            continue
        x0 = max(0, int(min(float(x["x0"]) for x in evs)) - 10)
        y0 = max(0, int(min(float(x["y0"]) for x in evs)) - 10)
        x1 = min(w, int(max(float(x["x1"]) for x in evs)) + 10)
        y1 = min(h, int(max(float(x["y1"]) for x in evs)) + 10)
        boxes.append(dict(x0=x0, y0=y0, x1=x1, y1=y1, t0=0.0, t1=float(duration or 0)))

    by_id = {e["id"]: e for e in events}

    # 注意：不要按「落在遮罩框里」丢字幕——底部遮罩会连坐掉相邻的正常字幕
    by_id2 = {e["id"]: e for e in events}
    if args.text_scope == "important":
        kept = []
        for c in cues:
            if c["kind"] == "overlay":
                ev = by_id2.get(c.get("ref"))
                if ev is not None and not is_caption(ev, w, h):
                    continue
            kept.append(c)
        cues = kept
    if not keep_speech:
        cues = [c for c in cues if c["kind"] != "speech"]
        progress(0.3, "cues", "画面字幕覆盖 %.0f%%，仅烧画面文字" % (overlay_cov * 100))
    cues = merge_cross_tier(cues)
    cues = settle_cues(cues, duration)
    progress(0.25, "cues", "%d 条字幕 / %d 处引流抹除（events=%d overlays=%d promo=%d）" % (len(cues), len(boxes), len(events), len(zh.get("overlays") or {}), len(promo)))
    ass_path = os.path.join(work, "subs.ass")
    with open(ass_path, "w") as fh:
        fh.write(ass_document(cues, w, h, zh.get("style")))

    src = load_json(os.path.join(work, "source.json"), {}) or {}
    video_in = src.get("path") or ""
    if not video_in or not os.path.exists(video_in):
        raise RuntimeError("源视频缺失: %s" % video_in)

    rendered = os.path.join(work, "rendered.mp4")
    crop = None if args.no_edge_crop else plan_crop(boxes, w, h)
    forced = load_json(os.path.join(work, "crop.json"), None)
    if forced and not args.no_edge_crop:
        try:
            fx0, fy0 = int(float(forced["x0"])), int(float(forced["y0"]))
            fx1, fy1 = int(float(forced["x1"])), int(float(forced["y1"]))
            tgt = float(w) / float(h)
            cw2, ch2 = fx1 - fx0, fy1 - fy0
            if cw2 / float(ch2) > tgt:
                fx0 += (cw2 - ch2 * tgt) / 2.0
                fx1 = fx0 + ch2 * tgt
            else:
                fy0 += (ch2 - cw2 / tgt) / 2.0
                fy1 = fy0 + cw2 / tgt
            crop = (int(max(0, fx0)), int(max(0, fy0)), int(min(w, fx1)), int(min(h, fy1)))
        except (KeyError, TypeError, ValueError):
            crop = crop
    if crop:
        boxes = apply_crop(boxes, crop, w, h)
        progress(0.6, "crop", "边缘引流信息改为裁切 %d,%d-%d,%d" % crop)
    filt = build_filter(boxes, ass_path, args.fonts_dir, w, h, crop)
    run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", video_in,
         "-filter_complex", filt, "-map", "[vout]", "-map", "0:a?",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", rendered], timeout=3600)
    progress(0.7, "render", "成片完成")

    # 成品文件：--no-folder 时先放 work，稍后由 deliver.py 按顺序归档并改名
    folder_name = "%d 已完成" % args.index
    final_dir = os.path.join(args.out, folder_name)
    safe_title = re.sub(r"[\\/:*?\"<>|\r\n\t]+", " ", title).strip() or ("视频%d" % args.index)
    video_name = safe_title + ".mp4"
    render_only = bool(args.no_folder)
    if render_only:
        stage_dir = work
        names = dict(cover="cover.jpg", srt="zh.srt", srtBi="bi.srt", doc="copy.txt", meta="meta.json")
    else:
        stage_dir = final_dir
        if os.path.isdir(stage_dir):
            shutil.rmtree(stage_dir)
        os.makedirs(stage_dir, exist_ok=True)
        names = dict(cover="视频封面.jpg", srt="中文字幕.srt", srtBi="中外对照字幕.srt",
                     doc="文案.txt", meta="meta.json")
        shutil.copy2(rendered, os.path.join(stage_dir, video_name))

    cover_t = float(zh.get("coverT") or 0.0)
    if cover_t < 0.2 or cover_t > max(0.5, duration - 0.3):
        cover_t = min(1.0, max(0.0, duration / 3.0))
    clean = (load_json(os.path.join(work, "summary.json"), {}) or {}).get("cleanTimes") or []

    def busy(t):
        for e in events:
            if e["t0"] - 0.4 <= t <= e["t1"] + 0.4 and (e["x1"] - e["x0"]) * (e["y1"] - e["y0"]) > 2500:
                return True
        return False

    if busy(cover_t) and clean:
        near = [t for t in clean if abs(t - cover_t) <= 15] or clean
        cover_t = sorted(near, key=lambda t: abs(t - cover_t))[0]
    cover = os.path.join(stage_dir, names["cover"])
    title_txt = os.path.join(work, "cover_title.txt")
    with open(title_txt, "w") as fh:
        fh.write(title)
    tw = width_weight(title)
    scale_c = max(0.5, float(w) / 720.0)
    title_fs = int(max(round(28 * scale_c), min(round(46 * scale_c), (w - 96) / max(6.0, tw))))
    drawtext = ("drawtext=fontfile=%s:textfile=%s:fontsize=%d:fontcolor=white:"
                "box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=88") % (
        esc_filter_path(args.font), esc_filter_path(title_txt), title_fs)
    run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", "%.2f" % cover_t,
         "-i", rendered, "-frames:v", "1", "-vf", drawtext, "-q:v", "2", cover])
    progress(0.82, "cover", "封面完成")

    write_srt(os.path.join(stage_dir, names["srt"]), cues, False)
    write_srt(os.path.join(stage_dir, names["srtBi"]), cues, True)

    with open(os.path.join(stage_dir, names["doc"]), "w") as fh:
        fh.write("标题\n%s\n\n正文\n%s\n\n垂类\n%s\n\n字幕条数\n%d\n\n时长\n%.1f 秒\n" % (
            title, body or "（未生成）", vertical or "未判定", len(cues), duration))

    meta = dict(index=args.index, title=title, body=body, vertical=vertical,
                folder=folder_name, dir=final_dir, video=video_name,
                cover="视频封面.jpg", srt="中文字幕.srt", srtBi="中外对照字幕.srt",
                cues=len(cues), promotions=len(boxes), duration=round(duration, 2),
                coverT=round(cover_t, 2), source=src.get("name", ""), link=src.get("link", ""),
                language=zh.get("language", ""), note=zh.get("note", ""),
                asr=bool(segments), dedupe=len(dedupe), delivered=not render_only)
    with open(os.path.join(stage_dir, names["meta"]), "w") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    progress(1.0, "compose", folder_name)
    log("COMPOSE_OK %s" % json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
