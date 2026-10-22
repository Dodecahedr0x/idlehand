import subprocess
import unittest

from idlehand.radicle import _cob_from

ISSUE = "e4255cc2a0a65b543c2b5badac14bf9e0d9f409f"
OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


class IssueIdTests(unittest.TestCase):
    def test_labeled_id_wins_over_a_later_hash(self) -> None:
        text = f"│ Issue   {ISSUE}\n│ See commit {OTHER}\n"
        result = subprocess.CompletedProcess(["rad"], 0, text, "")
        self.assertEqual(_cob_from(result), ISSUE)

    def test_a_hash_without_an_issue_label_is_not_an_id(self) -> None:
        text = f"opened nothing\nsee {OTHER}\n"
        result = subprocess.CompletedProcess(["rad"], 0, text, "")
        self.assertEqual(_cob_from(result), "")
