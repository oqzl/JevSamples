import csv
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import jra_backtest as jb


class TestJraBacktest(unittest.TestCase):
    def test_resolve_headers(self):
        m = jb.resolve(["レースID", "馬名", "馬番", "着順", "単勝", "人気"])
        self.assertEqual(m["race_id"], "レースID")
        self.assertEqual(m["horse_name"], "馬名")
        self.assertEqual(m["finish"], "着順")

    def test_number(self):
        self.assertEqual(jb.number("482(+6)"), 482)
        self.assertEqual(jb.integer("3"), 3)
        self.assertIsNone(jb.integer("取消"))

    def test_blind_state_hides_identity_market_and_current_outcome(self):
        with tempfile.TemporaryDirectory() as d:
            db = jb.connect(Path(d) / "t.sqlite3")
            db.executescript(jb.SCHEMA)
            db.execute("INSERT INTO races VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       ("202001010101","2020-01-01","Tokyo",1,None,None,1600,"turf","good","fine",2))
            db.execute("INSERT INTO races VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       ("202002010101","2020-02-01","Tokyo",1,None,None,1600,"turf","good","fine",2))
            old=("202001010101","2020-01-01","h1","Secret Horse","1",1,2,"M4",56,"Secret Jockey","Secret Trainer",3.2,2,480,2,34.2)
            cur1=("202002010101","2020-02-01","h1","Secret Horse","1",1,1,"M4",56,"Secret Jockey","Secret Trainer",2.0,1,482,2,33.8)
            cur2=("202002010101","2020-02-01","h2","Other Horse","2",2,2,"M4",56,"Other Jockey","Other Trainer",4.0,2,470,0,34.0)
            db.executemany("INSERT INTO runners VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[old,cur1,cur2])
            built=jb.build_state(db,"202002010101")
            state,mapping=built
            blob=str(state)
            self.assertNotIn("Secret Horse",blob)
            self.assertNotIn("Secret Jockey",blob)
            self.assertNotIn("2.0",blob)
            self.assertEqual(mapping["r01"]["finish"],1)
            self.assertEqual(state["runners"][0]["history"]["recent_finishes"],[2])

    def test_questions_closed_set(self):
        state={"runners":[{"runner_id":"r01","post":1},{"runner_id":"r02","post":2}]}
        q=jb.questions(state)
        self.assertEqual(set(q["winner"]["criteria"]),{"r01","r02"})
        self.assertEqual(q["top3_r01"]["type"],"noul")


if __name__ == "__main__":
    unittest.main()
