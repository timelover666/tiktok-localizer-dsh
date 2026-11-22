#!/usr/bin/env python3
"""Stage 1 — 画面 OCR + 人声 ASR + 文字事件聚类（纯标准库，可选 faster-whisper）。

用法:
  python3 analyze.py --video <mp4> --work <workdir> [--fps 4] [--langs ja-JP,ko-KR,en-US]
                     [--ffmpeg path] [--ocr path] [--asr-model small] [--asr-models dir]

产物（写入 workdir）:
  probe.json    {duration,width,height,fps,audio}
  ocr.jsonl     每帧一行的 OCR 原始结果
  events.json   [{id,t0,t1,text,n,x0,y0,x1,y1,h}]
  asr.json      {ok,language,segments:[{t0,t1,text}],error}
  review.txt    人读事件清单，供翻译模型使用
  summary.json  {events,asr,language,duration,cleanTimes}
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))


def log(*args):
    print(*args, flush=True)


def progress(ratio, stage, message=""):
    log("PROGRESS %s %s %s" % (round(float(ratio), 3), stage, message))


def run(cmd, timeout=None, env=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode != 0:
        raise RuntimeError(
            "command failed (%s): %s\n%s" % (p.returncode, " ".join(cmd[:4]), (p.stderr or "")[-1200:]))
    return p


def probe(ff, src):
    p = subprocess.run([ff, "-hide_banner", "-i", src], capture_output=True, text=True)
    text = p.stderr or ""
    duration = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if m:
        duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    w = h = 0
    m = re.search(r"Video:[^,]+,.*?(\d{2,5})x(\d{2,5})", text)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    fps = 0.0
    m = re.search(r"(\d+(?:\.\d+)?)\s*fps", text)
    if m:
        fps = float(m.group(1))
    audio = "Audio:" in text
    return dict(duration=round(duration, 2), width=w, height=h, fps=fps, audio=audio)


def extract_frames(ff, src, fdir, fps, width):
    if os.path.isdir(fdir):
        shutil.rmtree(fdir)
    os.makedirs(fdir, exist_ok=True)
    vf = "fps=%s" % fps
    if width:
        vf += ",scale=%d:-2" % width
    run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
         "-vf", vf, "-q:v", "3", os.path.join(fdir, "f_%05d.jpg")])
    names = sorted(os.listdir(fdir))
    return [os.path.join(fdir, n) for n in names if n.endswith(".jpg")]


def ocr_frames(ocr_bin, frames, jobs, env):
    if not frames:
        return []
    jobs = max(1, min(jobs, len(frames)))
    chunks = [frames[i::jobs] for i in range(jobs)]
    procs = []
    for i, chunk in enumerate(chunks):
        if not chunk:
            continue
        procs.append(subprocess.Popen([ocr_bin] + chunk, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, env=env))
    rows = []
    for p in procs:
        out = p.communicate()[0] or ""
        for line in out.splitlines():
            line = line.strip()
            if line:
                rows.append(line)
    rows.sort(key=lambda s: json.loads(s).get("f", ""))
    return rows


def load_frames(rows, fps, target_w=0, target_h=0):
    frames = []
    for line in rows:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        name = os.path.basename(d.get("f") or "")
        m = re.search(r"(\d+)", name)
        if not m:
            continue
        idx = int(m.group(1))
        fw, fh = float(d.get("w") or 720), float(d.get("h") or 1280)
        fx = (float(target_w) / fw) if target_w else 1.0
        fy = (float(target_h) / fh) if target_h else 1.0
        items = []
        for l in d.get("lines") or []:
            t = (l.get("t") or "").strip()
            if not t:
                continue
            items.append(dict(
                text=t,
                x=l["x"] * fw * fx,
                y=(1.0 - l["y"] - l["h"]) * fh * fy,
                w=l["w"] * fw * fx,
                h=l["h"] * fh * fy,
                conf=l.get("c", 0.0),
                idx=idx,
            ))
        frames.append(dict(idx=idx, t=(idx - 1) / float(fps), items=items))
    frames.sort(key=lambda f: f["idx"])
    return frames


def norm(s):
    return "".join(ch for ch in s.lower() if ch.isalnum())


def sim(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a.startswith(b) or b.startswith(a):
        return 0.9
    # 字符级 LCS 比例（短文本够用，避免引入 difflib 的开销差异）
    la, lb = len(a), len(b)
    prev = [0] * (lb + 1)
    for i in range(1, la + 1):
        cur = [0] * (lb + 1)
        ai = a[i - 1]
        for j in range(1, lb + 1):
            cur[j] = prev[j - 1] + 1 if ai == b[j - 1] else max(prev[j], cur[j - 1])
        prev = cur
    return prev[lb] / float(max(la, lb))


def cluster(frames, fps):
    clusters = []
    for f in frames:
        used = set()
        for cl in clusters:
            if f["idx"] - cl["last_idx"] > 2:
                continue
            best, bi = 0.0, None
            last = cl["items"][-1]
            for i, it in enumerate(f["items"]):
                if i in used:
                    continue
                s = sim(norm(it["text"]), norm(last["text"]))
                dy = abs((it["y"] + it["h"] / 2) - (last["y"] + last["h"] / 2))
                if s > 0.75 and dy < 90:
                    score = s - dy / 1000.0
                    if score > best:
                        best, bi = score, i
            if bi is not None:
                used.add(bi)
                cl["items"].append(f["items"][bi])
                cl["last_idx"] = f["idx"]
        for i, it in enumerate(f["items"]):
            if i not in used:
                clusters.append(dict(items=[it], last_idx=f["idx"]))

    events = []
    for cl in clusters:
        items = cl["items"]
        dur = (items[-1]["idx"] - items[0]["idx"]) / float(fps)
        if len(items) < 2 or dur < 0.3:
            continue
        texts = [it["text"] for it in items]
        text = Counter(texts).most_common(1)[0][0]
        x0 = min(it["x"] for it in items)
        y0 = min(it["y"] for it in items)
        x1 = max(it["x"] + it["w"] for it in items)
        y1 = max(it["y"] + it["h"] for it in items)
        hs = sorted(it["h"] for it in items)
        events.append(dict(
            t0=round(items[0]["idx"] / float(fps) - 0.2, 2),
            t1=round(items[-1]["idx"] / float(fps), 2),
            text=text,
            n=len(items),
            x0=round(x0, 1), y0=round(y0, 1), x1=round(x1, 1), y1=round(y1, 1),
            h=round(hs[len(hs) // 2], 1),
            conf=round(sum(it["conf"] for it in items) / len(items), 3),
        ))
    events.sort(key=lambda e: (e["t0"], e["y0"]))
    for i, e in enumerate(events):
        e["id"] = i
    return events


def _run_whisper(model_name, audio, models_dir, language, env, vad=True):
    python = sys.executable
    script = (
        "import json,sys\n"
        "from faster_whisper import WhisperModel\n"
        "model_name, audio, root, lang, vad = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]\n"
        "m = WhisperModel(model_name, device='cpu', compute_type='int8', download_root=root)\n"
        "segs, info = m.transcribe(audio, vad_filter=(vad == '1'), beam_size=5, language=(lang or None))\n"
        "out = {'language': info.language, 'probability': float(info.language_probability), 'segments': []}\n"
        "for s in segs:\n"
        "    t = (s.text or '').strip()\n"
        "    if t: out['segments'].append({'t0': round(float(s.start), 2), 't1': round(float(s.end), 2), 'text': t})\n"
        "print(json.dumps(out, ensure_ascii=False))\n"
    )
    os.makedirs(models_dir, exist_ok=True)
    p = subprocess.run([python, "-c", script, model_name, audio, models_dir, language or "", "1" if vad else "0"],
                       capture_output=True, text=True, timeout=2400, env=env)
    if p.returncode != 0:
        return None, (p.stderr or "faster-whisper 退出异常").strip()[-600:]
    try:
        return json.loads((p.stdout or "").strip().splitlines()[-1]), ""
    except (ValueError, IndexError) as exc:
        return None, "无法解析识别结果: %s" % exc


def model_is_local(models_dir, name):
    if not name:
        return False
    if os.path.isdir(name):
        return os.path.exists(os.path.join(name, "model.bin")) or os.path.exists(os.path.join(name, "model.fp16.bin"))
    tag = "models--Systran--faster-whisper-" + name.replace(".", "-")
    snaps = os.path.join(models_dir, tag, "snapshots")
    if not os.path.isdir(snaps):
        return False
    for rev in os.listdir(snaps):
        d = os.path.join(snaps, rev)
        if os.path.exists(os.path.join(d, "model.bin")):
            return True
    return False


def prepare_asr(ff, src, work, model_name, models_dir, language):
    """抽出音轨、测音量、把 whisper 作为后台进程启动（与 OCR 并行）。"""
    handle = dict(result=dict(ok=False, language=language or "", segments=[], error="",
                              engine="faster-whisper"))
    audio = os.path.join(work, "audio.wav")
    try:
        run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src,
             "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audio])
    except Exception as exc:  # noqa: BLE001
        handle["result"]["error"] = "音频抽取失败: %s" % exc
        return handle
    try:
        probe = subprocess.run([ff, "-hide_banner", "-i", audio, "-af", "volumedetect", "-f", "null", "-"],
                               capture_output=True, text=True)
        m = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", probe.stderr or "")
        if m and float(m.group(1)) < -50.0:
            handle["result"]["error"] = "音轨近乎无声（%.1f dB），跳过语音识别" % float(m.group(1))
            return handle
    except Exception:
        pass

    env = dict(os.environ)
    env.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    extra = os.path.join(HERE, "pylib")
    if os.path.isdir(extra):
        env["PYTHONPATH"] = extra + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    chosen = model_name
    note = ""
    if not model_is_local(models_dir, model_name):
        for cand in ("base", "small", "tiny"):
            if model_is_local(models_dir, cand):
                chosen = cand
                note = "（%s 模型未下载，本次用 %s）" % (model_name, cand)
                break
    script = (
        "import json,sys\n"
        "from faster_whisper import WhisperModel\n"
        "model_name, audio, root, lang = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]\n"
        "m = WhisperModel(model_name, device='cpu', compute_type='int8', download_root=root)\n"
        "segs, info = m.transcribe(audio, vad_filter=True, beam_size=5, language=(lang or None))\n"
        "out = {'language': info.language, 'probability': float(info.language_probability), 'segments': []}\n"
        "for s in segs:\n"
        "    t = (s.text or '').strip()\n"
        "    if t: out['segments'].append({'t0': round(float(s.start), 2), 't1': round(float(s.end), 2), 'text': t})\n"
        "print(json.dumps(out, ensure_ascii=False))\n"
    )
    os.makedirs(models_dir, exist_ok=True)
    out_path = os.path.join(work, "asr_raw.json")
    fh = open(out_path, "w")
    proc = subprocess.Popen([sys.executable, "-c", script, chosen, audio, models_dir, language or ""],
                            stdout=fh, stderr=subprocess.PIPE, text=True, env=env)
    handle.update(proc=proc, fh=fh, out=out_path, audio=audio, chosen=chosen, note=note,
                  env=env, language=language)
    return handle


def collect_asr(handle, model_name, models_dir, language, duration=0.0):
    """等 whisper 结束并解析；失败时同步回退 tiny / 再试无 VAD。"""
    result = handle.get("result") or dict(ok=False, language=language or "", segments=[], error="")
    proc = handle.get("proc")
    if proc is None:
        return result
    try:
        _, err = proc.communicate(timeout=2400)
    except subprocess.TimeoutExpired:
        proc.kill()
        result["error"] = "语音识别超时"
        handle["fh"].close()
        return result
    handle["fh"].close()
    payload = None
    if proc.returncode == 0:
        try:
            payload = json.loads(open(handle["out"]).read().strip().splitlines()[-1])
        except (ValueError, IndexError):
            payload = None
    note = handle.get("note") or ""
    if payload is None:
        error = (err or "faster-whisper 退出异常").strip()[-600:]
        fb, fb_err = _run_whisper("tiny", handle["audio"], models_dir, language, handle["env"])
        if fb is not None:
            payload, note = fb, "（%s 不可用，已回退 tiny）" % handle.get("chosen", model_name)
            result["engine"] = "faster-whisper:tiny"
        else:
            result["error"] = "%s / tiny: %s" % (error[:300], fb_err[:300])
            try:
                os.remove(handle["audio"])
            except OSError:
                pass
            return result
    segments = payload.get("segments") or []
    if duration and len(segments) <= max(1, int(duration / 25.0)):
        wider, _ = _run_whisper(handle.get("chosen", model_name), handle["audio"], models_dir,
                                language, handle["env"], vad=False)
        if wider and len(wider.get("segments") or []) > len(segments):
            segments = wider["segments"]
            note = note or "（VAD 切分过少，改用整段识别）"
    result.update(ok=True, language=payload.get("language") or "", segments=segments,
                  probability=payload.get("probability"), note=note)
    try:
        os.remove(handle["audio"])
    except OSError:
        pass
    return result


def clean_times(events, duration, count=6):
    """挑画面文字最少的时刻，供封面候选。"""
    if duration <= 0:
        return []
    busy = [(e["t0"], e["t1"], (e["x1"] - e["x0"]) * (e["y1"] - e["y0"])) for e in events]
    cands = []
    step = max(0.5, duration / 40.0)
    t = 0.3
    while t < duration - 0.2:
        score = 0.0
        for t0, t1, area in busy:
            if t0 - 0.4 <= t <= t1 + 0.4:
                score += area
        cands.append((score, round(t, 2)))
        t += step
    cands.sort()
    picks = []
    for _, t in cands:
        if all(abs(t - p) > max(1.0, duration / 12.0) for p in picks):
            picks.append(t)
        if len(picks) >= count:
            break
    return picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--fps", type=float, default=4.0)
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--langs", default="ja-JP,ko-KR,en-US")
    ap.add_argument("--ffmpeg", default=os.path.join(HERE, "bin", "ffmpeg"))
    ap.add_argument("--ocr", default=os.path.join(HERE, "bin", "ocrmix"))
    ap.add_argument("--ocr-jobs", type=int, default=6)
    ap.add_argument("--asr-model", default="small")
    ap.add_argument("--asr-models", default=os.path.join(HERE, "models"))
    ap.add_argument("--asr-language", default="")
    ap.add_argument("--skip-asr", action="store_true")
    ap.add_argument("--ocr-only", action="store_true", help="只用 OCR，不跑人声识别（默认模式）")
    args = ap.parse_args()

    os.makedirs(args.work, exist_ok=True)
    ff = args.ffmpeg or "ffmpeg"
    ocr_bin = args.ocr or shutil.which("ocrmix") or ""

    info = probe(ff, args.video)
    json.dump(info, open(os.path.join(args.work, "probe.json"), "w"), ensure_ascii=False, indent=1)
    progress(0.06, "probe", "%s×%s %ss" % (info["width"], info["height"], info["duration"]))

    if not ocr_bin or not os.path.exists(ocr_bin):
        raise RuntimeError("OCR 组件缺失：%s" % ocr_bin)

    asr_handle = None
    if not args.skip_asr and not args.ocr_only:
        asr_handle = prepare_asr(ff, args.video, args.work, args.asr_model, args.asr_models, args.asr_language)
        progress(0.12, "asr", "语音识别已在后台开始")
    else:
        asr_handle = dict(result=dict(ok=False, language="", segments=[], error="已跳过 ASR", engine="none"))

    # 有没有人声：只测能量，不跑识别，几毫秒完成
    has_speech = False
    try:
        probe_audio = subprocess.run([ff, "-hide_banner", "-i", args.video, "-af", "volumedetect", "-f", "null", "-"],
                                     capture_output=True, text=True)
        m = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", probe_audio.stderr or "")
        if m and float(m.group(1)) > -45.0:
            has_speech = True
    except Exception:
        has_speech = False

    fdir = os.path.join(args.work, "frames")
    frames = extract_frames(ff, args.video, fdir, args.fps, args.width)
    progress(0.18, "frames", "%d 帧" % len(frames))

    env = dict(os.environ)
    env["OCR_LANGS"] = args.langs
    rows = ocr_frames(ocr_bin, frames, args.ocr_jobs, env)
    with open(os.path.join(args.work, "ocr.jsonl"), "w") as fh:
        fh.write("\n".join(rows) + "\n")
    progress(0.45, "ocr", "%d 帧完成" % len(rows))

    events = cluster(load_frames(rows, args.fps, info.get("width") or 0, info.get("height") or 0), args.fps)
    json.dump(events, open(os.path.join(args.work, "events.json"), "w"), ensure_ascii=False, indent=1)
    progress(0.55, "events", "%d 条画面文字" % len(events))

    coverage_now = 0.0
    if events and (info.get("duration") or 0) > 0:
        Hh = float(info.get("height") or 0) or 1.0
        spans = sorted((e["t0"], e["t1"]) for e in events if (e.get("h") or 0) >= 0.02 * Hh)
        merged = []
        for a, b in spans:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        coverage_now = sum(b - a for a, b in merged) / float(info.get("duration") or 1.0)

    if args.ocr_only:
        # ASR 已停用：只做音量检测判断有无朗读，不做任何语音识别
        asr = dict(ok=False, language="", segments=[], error="ASR 已停用（仅 OCR）", engine="none")
    else:
        asr = collect_asr(asr_handle, args.asr_model, args.asr_models, args.asr_language,
                          info.get("duration") or 0.0)
    json.dump(asr, open(os.path.join(args.work, "asr.json"), "w"), ensure_ascii=False, indent=1)
    progress(0.82, "asr", ("%d 条口播 / %s" % (len(asr["segments"]), asr["language"])) if asr["ok"] else asr["error"][:120])

    lines = ["# video: %s" % os.path.basename(args.video),
             "# duration: %ss  size: %sx%s  events: %d  asr: %s" % (
                 info["duration"], info["width"], info["height"], len(events),
                 "ok/%s" % asr["language"] if asr["ok"] else "unavailable"),
             "# 格式: 编号 <TAB> 起止时间 <TAB> 坐标框 <TAB> 字号高 <TAB> 原文", ""]
    for e in events:
        lines.append("%d\t%.2f-%.2f\t(%d,%d)-(%d,%d)\tlh=%d\t%s" % (
            e["id"], e["t0"], e["t1"], e["x0"], e["y0"], e["x1"], e["y1"], e["h"], e["text"]))
    open(os.path.join(args.work, "review.txt"), "w").write("\n".join(lines) + "\n")

    dur = float(info.get("duration") or 0.0)
    H = float(info.get("height") or 0) or 1.0
    cap = [e for e in events if (e.get("h") or 0) >= 0.02 * H and e.get("n", 0) >= 2]
    spans = sorted((e["t0"], e["t1"]) for e in cap)
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    coverage = (sum(b - a for a, b in merged) / dur) if dur > 0 else 0.0
    no_both = (len(cap) < 3 or coverage < 0.15) and not has_speech and not (asr.get("segments") or [])
    summary = dict(events=len(events), captionEvents=len(cap), captionCoverage=round(coverage, 3),
                   hasSpeech=has_speech, noSpeechNoCaptions=no_both,
                   asr=len(asr["segments"]), asrOk=asr["ok"],
                   asrLanguage=asr["language"], asrError=asr["error"],
                   duration=info["duration"], cleanTimes=clean_times(events, info["duration"]))
    json.dump(summary, open(os.path.join(args.work, "summary.json"), "w"), ensure_ascii=False, indent=1)
    try:
        shutil.rmtree(fdir)
    except OSError:
        pass
    progress(1.0, "analyze", "完成")
    log("ANALYZE_OK %s" % json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
