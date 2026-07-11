import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import db


class HistoryTrackRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "vocaltune.db"
        self.separated = self.root / "separated"
        self.separated.mkdir()
        self.patches = [
            patch.object(db, "DB_PATH", self.db_path),
            patch.object(db, "SEPARATED_DIR", self.separated),
        ]
        for item in self.patches:
            item.start()
        db.init_db()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def create_history(self, job_id="job123", stems="6", tracks=None):
        user_id = db.get_or_create_user("ricky")
        song_id = db.create_song_record(job_id, "youtube", stems)
        db.update_song_status_db(job_id, "completed", tracks_dict=tracks or {})
        db.add_user_history(user_id, song_id)

    def test_completed_history_rebuilds_six_tracks_from_disk(self):
        self.create_history(tracks={})
        output = self.separated / "job123"
        output.mkdir()
        for name in db.expected_track_names("6"):
            (output / f"{name}.wav").touch()

        item = db.get_user_history_list("ricky")[0]
        self.assertEqual(item["status"], "completed")
        self.assertEqual(set(item["tracks"]), set(db.expected_track_names("6")))

    def test_completed_history_with_missing_track_becomes_error(self):
        self.create_history(tracks={"vocals": "/old/path.wav"})
        output = self.separated / "job123"
        output.mkdir()
        (output / "vocals.wav").touch()

        item = db.get_user_history_list("ricky")[0]
        self.assertEqual(item["status"], "error")
        self.assertEqual(item["tracks"], {})
        self.assertIn("不完整", item["error_message"])


if __name__ == "__main__":
    unittest.main()
