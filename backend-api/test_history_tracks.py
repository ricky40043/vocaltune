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
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.patches = [
            patch.object(db, "DB_PATH", self.db_path),
            patch.object(db, "SEPARATED_DIR", self.separated),
            patch.object(db, "DOWNLOADS_DIR", self.downloads),
        ]
        for item in self.patches:
            item.start()
        db.init_db()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp_dir.cleanup()

    def create_history(self, job_id="job123", stems="6", tracks=None, file_path=None):
        user_id = db.get_or_create_user("ricky")
        song_id = db.create_song_record(job_id, "youtube", stems, file_path=str(file_path) if file_path else None)
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
        self.assertNotIn("original", item["tracks"])

    def test_completed_history_with_missing_track_becomes_error(self):
        self.create_history(tracks={"vocals": "/old/path.wav"})
        output = self.separated / "job123"
        output.mkdir()
        (output / "vocals.wav").touch()

        item = db.get_user_history_list("ricky")[0]
        self.assertEqual(item["status"], "error")
        self.assertEqual(item["tracks"], {})
        self.assertIn("不完整", item["error_message"])

    def test_history_exposes_existing_source_separately_from_tracks(self):
        source = self.downloads / "source.m4a"
        source.touch()
        self.create_history(tracks={}, file_path=source)
        output = self.separated / "job123"
        output.mkdir()
        for name in db.expected_track_names("6"):
            (output / f"{name}.wav").touch()

        item = db.get_user_history_list("ricky")[0]
        self.assertTrue(item["source_available"])
        self.assertEqual(item["source_url"], "/files/downloads/source.m4a")
        self.assertNotIn("original", item["tracks"])

    def test_history_marks_deleted_source_unavailable(self):
        self.create_history(tracks={}, file_path=self.downloads / "missing.m4a")
        item = db.get_user_history_list("ricky")[0]
        self.assertFalse(item["source_available"])
        self.assertIsNone(item["source_url"])

    def test_completed_history_media_is_preserved_from_cleanup(self):
        source = self.downloads / "keep-me.m4a"
        source.touch()
        self.create_history(job_id="keep-job", tracks={}, file_path=source)
        job_ids, source_names = db.get_preserved_history_media()
        self.assertIn("keep-job", job_ids)
        self.assertIn("keep-me.m4a", source_names)


if __name__ == "__main__":
    unittest.main()
