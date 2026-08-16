"""Chunker tests. Stdlib only, so they run in the app image as-is:

    docker compose run --rm --entrypoint python tts -m unittest discover tests
"""

import unittest

from app.engine import chunk_text

FIRST, LIMIT = 60, 320


def words(chunks):
    return " ".join(chunks).split()


class ChunkTextTest(unittest.TestCase):
    def test_empty_input_yields_nothing(self):
        for text in ("", "   ", "\n\n  \t"):
            self.assertEqual(chunk_text(text, FIRST, LIMIT), [])

    def test_short_text_is_one_chunk(self):
        text = "Just the one sentence here."
        self.assertEqual(chunk_text(text, FIRST, LIMIT), [text])

    def test_no_words_are_lost_or_reordered(self):
        text = " ".join(f"This is sentence number {i}, ready to be spoken." for i in range(30))
        self.assertEqual(words(chunk_text(text, FIRST, LIMIT)), text.split())

    def test_first_chunk_is_small_and_later_chunks_grow(self):
        text = "This is a sentence that is reasonably long. " * 12
        sizes = [len(c) for c in chunk_text(text, FIRST, LIMIT)]
        self.assertLessEqual(sizes[0], FIRST)
        self.assertGreater(max(sizes), FIRST)  # the ramp actually ramps
        self.assertLessEqual(max(sizes), LIMIT)

    def test_text_without_punctuation_still_splits(self):
        text = "word " * 200
        chunks = chunk_text(text, FIRST, LIMIT)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= LIMIT for c in chunks))

    def test_unbreakable_token_is_sliced_not_truncated(self):
        text = "a" * 700
        chunks = chunk_text(text, FIRST, LIMIT)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(c) <= LIMIT for c in chunks))

    def test_paragraph_breaks_are_boundaries(self):
        chunks = chunk_text("First.\n\nSecond.\n\nThird.", 8, 8)
        self.assertEqual(chunks, ["First.", "Second.", "Third."])


if __name__ == "__main__":
    unittest.main()
