import unittest

from media_progress import map_demucs_progress


class MediaProgressTests(unittest.TestCase):
    def test_demucs_progress_is_bounded_and_monotonic(self):
        values = [map_demucs_progress(value) for value in range(101)]
        self.assertEqual(values[0], 5)
        self.assertEqual(values[-1], 85)
        self.assertEqual(values, sorted(values))

    def test_out_of_range_values_are_clamped(self):
        self.assertEqual(map_demucs_progress(-10), 5)
        self.assertEqual(map_demucs_progress(150), 85)


if __name__ == "__main__":
    unittest.main()
