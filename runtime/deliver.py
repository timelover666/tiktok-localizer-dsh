#!/usr/bin/env python3
"""Stage 3 — 把已渲染的成品按链接顺序归档：先建「序号 已完成」文件夹，再按标题改名放入。

用法:
  python3 deliver.py --work <workdir> --index 3 --out <batchDir>

读取 workdir 中 compose.py --no-folder 生成的 rendered.mp4 / cover.jpg / zh.srt / bi.srt /
copy.txt / meta.json，创建 <index> 已完成/ 并把文件改名放入。
"""
import argparse
import json
import os
import re
import shutil

SAFE = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--index", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    args = ap.parse_args()

    work = args.work
    meta = load(os.path.join(work, "meta.json"))
    if not meta:
        raise SystemExit("缺少 meta.json：先运行 compose.py --no-folder")
    rendered = os.path.join(work, "rendered.mp4")
    if not os.path.exists(rendered):
        raise SystemExit("缺少 rendered.mp4")

    title = (args.title or meta.get("title") or ("视频%d" % args.index)).strip()
    safe_title = SAFE.sub(" ", title).strip(" .") or ("视频%d" % args.index)
    folder = "%d 已完成" % args.index
    dst = os.path.join(args.out, folder)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst, exist_ok=True)

    video_name = safe_title + ".mp4"
    shutil.copy2(rendered, os.path.join(dst, video_name))

    copies = [
        ("cover.jpg", "视频封面.jpg"),
        ("zh.srt", "中文字幕.srt"),
        ("bi.srt", "中外对照字幕.srt"),
        ("copy.txt", "文案.txt"),
    ]
    missing = []
    for source, target in copies:
        src_path = os.path.join(work, source)
        if os.path.exists(src_path):
            shutil.copy2(src_path, os.path.join(dst, target))
        else:
            missing.append(source)

    meta.update(folder=folder, dir=dst, video=video_name, title=title, delivered=True)
    with open(os.path.join(dst, "meta.json"), "w") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)

    print("DELIVER_OK %s" % json.dumps({
        "index": args.index, "folder": folder, "video": video_name,
        "missing": missing, "cues": meta.get("cues"), "title": title,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
