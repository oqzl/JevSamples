#!/usr/bin/env python3
"""Leakage-conscious Jev backtest for the Kaggle JRA historical race dataset.

No third-party Python packages are required.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
FEATURE_VERSION = "jra-v1"

ALIASES = {
    "race_id": ["レースID", "race_id", "raceid"],
    "date": ["レース日付", "日付", "race_date", "date"],
    "course": ["競馬場名", "競馬場", "racecourse", "course"],
    "race_no": ["レース番号", "race_number", "race_no", "R"],
    "race_name": ["レース名", "race_name"],
    "race_class": ["競走条件", "クラス", "race_class"],
    "distance": ["距離", "コース距離", "distance"],
    "surface": ["芝・ダート", "芝ダ", "surface"],
    "going": ["馬場状態", "馬場", "going"],
    "weather": ["天候", "weather"],
    "horse_id": ["馬ID", "horse_id"],
    "horse_name": ["馬名", "horse_name"],
    "frame": ["枠番", "frame"],
    "post": ["馬番", "horse_number", "post"],
    "finish": ["着順", "finish", "final_position"],
    "sex_age": ["性齢", "sex_age"],
    "carried_weight": ["斤量", "carried_weight", "weight_carried"],
    "jockey": ["騎手", "jockey"],
    "trainer": ["調教師", "trainer"],
    "odds": ["単勝", "単勝オッズ", "win_odds", "odds"],
    "popularity": ["人気", "単勝人気", "popularity"],
    "horse_weight": ["馬体重", "horse_weight"],
    "weight_change": ["馬体重増減", "weight_change"],
    "last3f": ["上り", "上がり", "上り3F", "last3f"],
}
REQUIRED = ("race_id", "horse_name", "post", "finish")


def compact(s):
    return re.sub(r"[\s_/・（）()\[\]-]+", "", (s or "").strip()).lower()


def resolve(headers):
    table = {compact(h): h for h in headers}
    out = {}
    for key, aliases in ALIASES.items():
        hit = next((table[compact(a)] for a in aliases if compact(a) in table), None)
        if hit is None:
            fuzzy = [h for h in headers if any(compact(a) in compact(h) for a in aliases)]
            hit = fuzzy[0] if len(fuzzy) == 1 else None
        out[key] = hit
    return out


def detect_encoding(path):
    sample = Path(path).read_bytes()[:65536]
    for enc in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            sample.decode(enc)
            return enc
        except UnicodeDecodeError:
            pass
    raise ValueError("Could not detect CSV encoding")


def text(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if not s or s.lower() in {"nan", "none", "null"} else s


def number(v):
    s = text(v)
    if s is None:
        return None
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s.replace(",", "").replace("kg", ""))
    return float(m.group()) if m else None


def integer(v):
    n = number(v)
    return int(n) if n is not None and float(n).is_integer() else None


def value(row, mapping, key):
    col = mapping.get(key)
    return text(row.get(col)) if col else None


def race_date(raw, race_id):
    for source in (raw, race_id):
        if not source:
            continue
        digits = re.sub(r"\D", "", source)
        if len(digits) >= 8:
            return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
        for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(source, fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
    raise ValueError(f"Cannot derive date for race {race_id!r}")


def distance(v):
    n = integer(v)
    return n if n is not None and 600 <= n <= 5000 else None


def connect(path):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(p)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    return db


SCHEMA = """
CREATE TABLE IF NOT EXISTS races(
  race_id TEXT PRIMARY KEY, race_date TEXT NOT NULL, course TEXT, race_no INTEGER,
  race_name TEXT, race_class TEXT, distance INTEGER, surface TEXT, going TEXT,
  weather TEXT, field_size INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runners(
  race_id TEXT NOT NULL, race_date TEXT NOT NULL, horse_key TEXT NOT NULL,
  horse_name TEXT NOT NULL, frame INTEGER, post INTEGER, finish INTEGER,
  sex_age TEXT, carried_weight REAL, jockey TEXT, trainer TEXT,
  win_odds REAL, popularity INTEGER, horse_weight REAL, weight_change REAL, last3f REAL,
  PRIMARY KEY(race_id, horse_key)
);
CREATE TABLE IF NOT EXISTS predictions(
  race_id TEXT NOT NULL, model TEXT NOT NULL, feature_version TEXT NOT NULL,
  market_mode TEXT NOT NULL, anonymized INTEGER NOT NULL, payload_hash TEXT NOT NULL,
  state_json TEXT NOT NULL, response_json TEXT NOT NULL, latency_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(race_id, model, feature_version, market_mode, anonymized)
);
CREATE INDEX IF NOT EXISTS idx_runner_horse_date ON runners(horse_key,race_date);
CREATE INDEX IF NOT EXISTS idx_runner_jockey_date ON runners(jockey,race_date);
CREATE INDEX IF NOT EXISTS idx_runner_trainer_date ON runners(trainer,race_date);
CREATE INDEX IF NOT EXISTS idx_race_date ON races(race_date,race_id);
"""


def inspect_csv(args):
    enc = detect_encoding(args.csv)
    with open(args.csv, encoding=enc, newline="") as fh:
        headers = next(csv.reader(fh))
    mapping = resolve(headers)
    print("encoding:", enc)
    print("headers:")
    for i, h in enumerate(headers):
        print(f"  {i:02d}: {h}")
    print("\nresolved:")
    for key in ALIASES:
        print(f"  {key:16} <- {mapping[key] or '-'}")


def build_db(args):
    db = connect(args.db)
    if args.reset:
        db.executescript("DROP TABLE IF EXISTS predictions;DROP TABLE IF EXISTS runners;DROP TABLE IF EXISTS races;")
    db.executescript(SCHEMA)
    enc = detect_encoding(args.csv)
    count = 0
    with open(args.csv, encoding=enc, newline="") as fh:
        reader = csv.DictReader(fh)
        mapping = resolve(reader.fieldnames or [])
        missing = [k for k in REQUIRED if not mapping.get(k)]
        if missing:
            raise SystemExit("Missing required columns: " + ", ".join(missing) + ". Run inspect first.")
        for row in reader:
            rid = value(row, mapping, "race_id")
            name = value(row, mapping, "horse_name")
            post = integer(value(row, mapping, "post"))
            if not rid or not name or post is None:
                continue
            dt = race_date(value(row, mapping, "date"), rid)
            horse_key = value(row, mapping, "horse_id") or name
            db.execute(
                """INSERT OR IGNORE INTO races
                (race_id,race_date,course,race_no,race_name,race_class,distance,surface,going,weather)
                VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (rid, dt, value(row,mapping,"course"), integer(value(row,mapping,"race_no")),
                 value(row,mapping,"race_name"), value(row,mapping,"race_class"),
                 distance(value(row,mapping,"distance")), value(row,mapping,"surface"),
                 value(row,mapping,"going"), value(row,mapping,"weather")),
            )
            db.execute(
                """INSERT OR REPLACE INTO runners
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (rid, dt, horse_key, name, integer(value(row,mapping,"frame")), post,
                 integer(value(row,mapping,"finish")), value(row,mapping,"sex_age"),
                 number(value(row,mapping,"carried_weight")), value(row,mapping,"jockey"),
                 value(row,mapping,"trainer"), number(value(row,mapping,"odds")),
                 integer(value(row,mapping,"popularity")), number(value(row,mapping,"horse_weight")),
                 number(value(row,mapping,"weight_change")), number(value(row,mapping,"last3f"))),
            )
            count += 1
            if count % 10000 == 0:
                db.commit()
                print(f"\r{count:,} rows", end="", flush=True)
    db.execute("UPDATE races SET field_size=(SELECT COUNT(*) FROM runners r WHERE r.race_id=races.race_id)")
    db.commit()
    print(f"\nready: {db.execute('SELECT COUNT(*) FROM races').fetchone()[0]:,} races / {count:,} runner rows")


def rate(xs, predicate):
    return sum(1 for x in xs if predicate(x)) / len(xs) if xs else None


def person_stats(db, column, identity, before):
    if not identity:
        return {"starts": 0, "win_rate": None, "top3_rate": None}
    rows = db.execute(
        f"SELECT finish FROM runners WHERE {column}=? AND race_date<? AND finish IS NOT NULL ORDER BY race_date DESC LIMIT 50",
        (identity, before),
    ).fetchall()
    xs = [r[0] for r in rows]
    return {"starts": len(xs), "win_rate": rate(xs, lambda x:x==1), "top3_rate": rate(xs, lambda x:x<=3)}


def horse_stats(db, runner, race):
    rows = db.execute(
        """SELECT rr.finish,r.course,r.distance,r.surface,r.race_date
           FROM runners rr JOIN races r USING(race_id)
           WHERE rr.horse_key=? AND rr.race_date<? AND rr.finish IS NOT NULL
           ORDER BY rr.race_date DESC,rr.race_id DESC LIMIT 8""",
        (runner["horse_key"], race["race_date"]),
    ).fetchall()
    xs = [r["finish"] for r in rows]
    same_course = [r["finish"] for r in rows if race["course"] and r["course"] == race["course"]]
    same_surface = [r["finish"] for r in rows if race["surface"] and r["surface"] == race["surface"]]
    near = [r["finish"] for r in rows if race["distance"] and r["distance"] and abs(r["distance"]-race["distance"]) <= 200]
    days = None
    if rows:
        days = (datetime.fromisoformat(race["race_date"]) - datetime.fromisoformat(rows[0]["race_date"])).days
    return {
        "starts_considered": len(xs),
        "recent_finishes": xs[:5],
        "win_rate": rate(xs, lambda x:x==1),
        "top3_rate": rate(xs, lambda x:x<=3),
        "avg_finish": sum(xs)/len(xs) if xs else None,
        "same_course_top3_rate": rate(same_course, lambda x:x<=3),
        "same_surface_top3_rate": rate(same_surface, lambda x:x<=3),
        "near_distance_top3_rate": rate(near, lambda x:x<=3),
        "days_since_last_run": days,
    }


def build_state(db, rid, market="blind", anonymized=True):
    race = db.execute("SELECT * FROM races WHERE race_id=?", (rid,)).fetchone()
    runners = db.execute("SELECT * FROM runners WHERE race_id=? ORDER BY post", (rid,)).fetchall()
    if not race or len(runners) < 2 or any(r["finish"] is None for r in runners):
        return None
    state_runners, mapping = [], {}
    for i, r in enumerate(runners, 1):
        code = f"r{i:02d}"
        item = {
            "runner_id": code, "post": r["post"], "frame": r["frame"], "sex_age": r["sex_age"],
            "carried_weight": r["carried_weight"], "horse_weight": r["horse_weight"],
            "weight_change": r["weight_change"], "history": horse_stats(db, r, race),
            "jockey_history": person_stats(db,"jockey",r["jockey"],race["race_date"]),
            "trainer_history": person_stats(db,"trainer",r["trainer"],race["race_date"]),
        }
        if not anonymized:
            item.update(horse_name=r["horse_name"], jockey=r["jockey"], trainer=r["trainer"])
        if market == "odds":
            item.update(win_odds=r["win_odds"], popularity=r["popularity"])
        state_runners.append(item)
        mapping[code] = {
            "horse_name": r["horse_name"], "finish": r["finish"],
            "win_odds": r["win_odds"], "popularity": r["popularity"],
        }
    state = {
        "task": "Predict this JRA race using only pre-race information in this state.",
        "information_boundary": "Do not rely on memorized real-world race results. Runner IDs are synthetic when anonymization is enabled. Treat missing values as unknown.",
        "race": {
            "month": race["race_date"][:7], "course": race["course"], "race_no": race["race_no"],
            "race_class": race["race_class"], "distance_m": race["distance"], "surface": race["surface"],
            "going": race["going"], "weather": race["weather"], "field_size": race["field_size"],
        },
        "runners": state_runners,
    }
    return state, mapping


def questions(state):
    criteria = {r["runner_id"]: f"Runner in post {r['post']}; choose if most likely to win." for r in state["runners"]}
    out = {"winner": {"type":"choice","instructions":"Which runner is most likely to win? Preserve uncertainty across all runners.","criteria":criteria}}
    for r in state["runners"]:
        code = r["runner_id"]
        out["top3_"+code] = {
            "type":"noul",
            "instructions":f"Is {code} likely to finish in the top three?",
            "criteria":{"true":"Top-three finish.","false":"Finishes fourth or worse."},
        }
    return out


def payload(state, model):
    return {"model":model,"state":state,"questions":questions(state)}


def call_typesafe(body, api_key, timeout=20, retries=3):
    raw = json.dumps(body, ensure_ascii=False, separators=(",",":")).encode()
    request = urllib.request.Request(API_URL, data=raw, method="POST", headers={
        "Authorization":"Bearer "+api_key, "Content-Type":"application/json", "Accept":"application/json"
    })
    for attempt in range(retries+1):
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as res:
                return json.loads(res.read()), round((time.perf_counter()-started)*1000)
        except urllib.error.HTTPError as e:
            if attempt < retries and (e.code in {408,429} or e.code >= 500):
                time.sleep(min(2**attempt, 8)); continue
            raise RuntimeError(f"TypeSafe HTTP {e.code}: {e.read().decode(errors='replace')[:500]}") from e
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(min(2**attempt,8)); continue
            raise RuntimeError(str(e)) from e


def candidate_ids(db, date_from=None, date_to=None, limit=20):
    where = ["field_size BETWEEN 5 AND 18"]
    params = []
    if date_from: where.append("race_date>=?"); params.append(date_from)
    if date_to: where.append("race_date<=?"); params.append(date_to)
    if not date_from and not date_to:
        max_date = db.execute("SELECT MAX(race_date) FROM races").fetchone()[0]
        where.append("race_date>=date(?,'-30 day')"); params.append(max_date)
    sql = "SELECT race_id FROM races WHERE " + " AND ".join(where) + " ORDER BY race_date,race_id LIMIT ?"
    params.append(limit)
    return [r[0] for r in db.execute(sql, params)]


def run(args):
    db = connect(args.db); db.executescript(SCHEMA)
    ids = candidate_ids(db,args.date_from,args.date_to,args.limit)
    if not ids: raise SystemExit("No races matched")
    key = os.environ.get("TYPESAFE_API_KEY")
    if not args.dry_run and not key: raise SystemExit("Set TYPESAFE_API_KEY")
    done = 0
    for rid in ids:
        built = build_state(db,rid,args.market,not args.identities)
        if not built: continue
        state,mapping = built
        body = payload(state,args.model)
        blob = json.dumps(body,sort_keys=True,ensure_ascii=False,separators=(",",":"))
        digest = hashlib.sha256(blob.encode()).hexdigest()
        if args.dry_run:
            print(json.dumps({"race_id":rid,"state":state,"questions":body["questions"]},ensure_ascii=False,indent=2))
            return
        cached = db.execute(
            "SELECT payload_hash FROM predictions WHERE race_id=? AND model=? AND feature_version=? AND market_mode=? AND anonymized=?",
            (rid,args.model,FEATURE_VERSION,args.market,int(not args.identities)),
        ).fetchone()
        if cached and cached[0] == digest and not args.force:
            print(rid, "cached"); continue
        response,latency = call_typesafe(body,key,args.timeout,args.retries)
        usage = response.get("usage",{})
        db.execute(
            """INSERT OR REPLACE INTO predictions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (rid,args.model,FEATURE_VERSION,args.market,int(not args.identities),digest,
             json.dumps({"state":state,"mapping":mapping},ensure_ascii=False),
             json.dumps(response,ensure_ascii=False),latency,usage.get("input_tokens"),
             usage.get("output_tokens"),datetime.now().isoformat(timespec="seconds")),
        ); db.commit()
        choice = response.get("answers",{}).get("winner",{}).get("choice")
        actual = [m["horse_name"] for m in mapping.values() if m["finish"]==1]
        predicted = mapping.get(choice,{}).get("horse_name",choice)
        print(f"{rid}: Jev={predicted} / actual={','.join(actual)} / {latency}ms")
        done += 1
    print("new predictions:",done)


def report(args):
    db = connect(args.db)
    rows = db.execute(
        """SELECT * FROM predictions WHERE model=? AND feature_version=? AND market_mode=? AND anonymized=? ORDER BY race_id""",
        (args.model,FEATURE_VERSION,args.market,int(not args.identities)),
    ).fetchall()
    if not rows: raise SystemExit("No cached predictions matched")
    n=hits=0; logloss=brier=0.0; stake=ret=fav_stake=fav_ret=0.0; fav_hits=0
    buckets=defaultdict(list)
    for row in rows:
        stored=json.loads(row["state_json"]); mapping=stored["mapping"]
        response=json.loads(row["response_json"]); win=response.get("answers",{}).get("winner",{})
        probs=win.get("probabilities",{})
        if not probs: continue
        winners={k for k,v in mapping.items() if v["finish"]==1}
        if not winners: continue
        pred=max(probs,key=probs.get); p_actual=max(sum(float(probs.get(k,0)) for k in winners),1e-12)
        n+=1; hits+=int(pred in winners); logloss-=math.log(p_actual)
        target=1/len(winners)
        brier+=sum((float(p)- (target if k in winners else 0))**2 for k,p in probs.items())
        top_p=float(probs[pred]); buckets[min(9,int(top_p*10))].append(int(pred in winners))
        pick=mapping[pred]
        if pick.get("win_odds") is not None:
            stake+=100
            if pred in winners: ret+=100*float(pick["win_odds"])
        favorites=[(k,v) for k,v in mapping.items() if v.get("popularity") is not None]
        if favorites:
            fk,fv=min(favorites,key=lambda kv:kv[1]["popularity"])
            fav_hits+=int(fk in winners)
            if fv.get("win_odds") is not None:
                fav_stake+=100
                if fk in winners: fav_ret+=100*float(fv["win_odds"])
    if not n: raise SystemExit("No evaluable responses")
    print("Races                 ",n)
    print(f"Jev top-1 accuracy     {hits/n:.3%}")
    print(f"Jev log loss           {logloss/n:.4f}")
    print(f"Jev multiclass Brier   {brier/n:.4f}")
    if stake: print(f"Jev flat-win ROI       {ret/stake:.2%}  ({ret:.0f}/{stake:.0f} yen-equivalent)")
    print(f"Favorite accuracy      {fav_hits/n:.3%}")
    if fav_stake: print(f"Favorite flat-win ROI  {fav_ret/fav_stake:.2%}  ({fav_ret:.0f}/{fav_stake:.0f} yen-equivalent)")
    print("\nCalibration by Jev max win probability:")
    for b in sorted(buckets):
        xs=buckets[b]; print(f"  [{b/10:.1f},{(b+1)/10:.1f}) n={len(xs):4d} actual_win={sum(xs)/len(xs):.2%}")


def main():
    p=argparse.ArgumentParser()
    sub=p.add_subparsers(dest="cmd",required=True)
    s=sub.add_parser("inspect"); s.add_argument("csv"); s.set_defaults(func=inspect_csv)
    s=sub.add_parser("build"); s.add_argument("csv"); s.add_argument("--db",default="data/jra/jra.sqlite3"); s.add_argument("--reset",action="store_true"); s.set_defaults(func=build_db)
    s=sub.add_parser("run"); s.add_argument("--db",default="data/jra/jra.sqlite3"); s.add_argument("--from",dest="date_from"); s.add_argument("--to",dest="date_to"); s.add_argument("--limit",type=int,default=20); s.add_argument("--market",choices=("blind","odds"),default="blind"); s.add_argument("--model",default=MODEL); s.add_argument("--identities",action="store_true"); s.add_argument("--dry-run",action="store_true"); s.add_argument("--force",action="store_true"); s.add_argument("--timeout",type=float,default=20); s.add_argument("--retries",type=int,default=3); s.set_defaults(func=run)
    s=sub.add_parser("report"); s.add_argument("--db",default="data/jra/jra.sqlite3"); s.add_argument("--market",choices=("blind","odds"),default="blind"); s.add_argument("--model",default=MODEL); s.add_argument("--identities",action="store_true"); s.set_defaults(func=report)
    args=p.parse_args(); args.func(args)

if __name__ == "__main__":
    main()
