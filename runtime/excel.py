#!/usr/bin/env python3
"""Stage 3 — 汇总 Excel：视频清单 + 原文对照。"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import xlsx  # noqa: E402


def parse_srt(path):
    if not os.path.exists(path):
        return []
    text = open(path, encoding="utf-8", errors="replace").read().replace("\r", "")
    out = []
    for block in re.split(r"\n\n+", text.strip()):
        lines = block.split("\n")
        if len(lines) < 3:
            continue
        times = lines[1]
        body = lines[2:]
        if "-->" not in times:
            continue
        start = times.split("-->")[0].strip()
        src = body[0] if len(body) >= 2 else ""
        zh = body[-1] if len(body) >= 2 else body[0]
        out.append((start, src, zh))
    return out


def collect(root):
    metas = []
    for name in sorted(os.listdir(root)):
        folder = os.path.join(root, name)
        if not os.path.isdir(folder):
            continue
        m = re.match(r"(\d+)\s*已完成", name)
        meta_path = os.path.join(folder, "meta.json")
        if not m or not os.path.exists(meta_path):
            continue
        try:
            meta = json.load(open(meta_path))
        except ValueError:
            continue
        meta["folder"] = name
        meta["dir"] = folder
        metas.append(meta)
    metas.sort(key=lambda x: x.get("index") or 0)
    return metas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    metas = collect(root)
    if not metas:
        raise SystemExit("没有找到成品文件夹（* 已完成/meta.json）")

    rows = [["序号", "中文标题", "垂类", "正文", "字幕条数", "引流抹除", "时长(秒)",
             "成品文件夹", "视频文件", "封面", "字幕", "原文件", "语言", "链接"]]
    for m in metas:
        rows.append([m.get("index"), m.get("title"), m.get("vertical"), m.get("body"),
                     m.get("cues"), m.get("promotions"), m.get("duration"),
                     m.get("folder"), m.get("video"), m.get("cover"), m.get("srtBi"),
                     m.get("source"), m.get("language"), m.get("link")])
    widths = [6, 26, 8, 40, 8, 9, 9, 16, 30, 12, 16, 34, 7, 28]

    detail = [["序号", "中文标题", "开始时间", "原文", "中文"]]
    for m in metas:
        for start, src, zh in parse_srt(os.path.join(m["dir"], m.get("srtBi") or "中外对照字幕.srt")):
            detail.append([m.get("index"), m.get("title"), start, src, zh])
    detail_widths = [6, 24, 14, 46, 46]

    out = args.out or os.path.join(root, "本地化汇总.xlsx")
    xlsx.write(out, [
        dict(name="视频清单", widths=widths, rows=rows),
        dict(name="原文对照", widths=detail_widths, rows=detail),
    ])
    print("EXCEL_OK %s %d" % (out, len(metas)))


if __name__ == "__main__":
    main()
