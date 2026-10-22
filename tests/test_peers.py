import json

from fossah.peers import explain_peer_url, normalize_peer_url, peer_url_allowed, review_second_degree, select_second_degree

HEURISTIC = {
    "min_endorsements": 1,
    "max_new_peers_per_cycle": 5,
    "max_peers": 50,
    "require_https": True,
    "allow_insecure_loopback": True,
    "allowed_hosts": [],
    "blocked_hosts": [],
}


def _select(documents, heuristic=None, existing=None, direct=None, self_id="self"):
    direct_peers = direct or [{"url": "https://direct.example/fossah/publish", "id": "d"}]
    return select_second_degree(
        self_id=self_id,
        self_urls={"http://127.0.0.1:47321/fossah/publish"},
        direct_peers=direct_peers,
        documents=documents,
        existing_urls=set(existing or []),
        heuristic=heuristic or HEURISTIC,
    )


def test_one_endorsement_adds_a_peer_and_not_a_file_url() -> None:
    documents = {
        "https://direct.example/fossah/publish": {
            "peers": [
                {"url": "https://second.example/fossah/publish", "id": "s"},
                {"url": "file:///tmp/secret"},
                {"url": "http://evil.example/fossah/publish"},
                "http://127.0.0.1:9/fossah/publish",
            ],
            "repos": [{"url": "https://github.com/someone/repo"}],
        }
    }
    chosen = _select(documents)
    urls = [item.url for item in chosen]
    assert "https://second.example/fossah/publish" in urls
    assert "http://127.0.0.1:9/fossah/publish" in urls
    assert all(not url.startswith("file:") for url in urls)
    assert all("evil.example" not in url for url in urls)


def test_review_explains_each_peer_and_does_not_import_repos() -> None:
    documents = {
        "https://direct.example/fossah/publish": {
            "peers": [
                {"url": "https://second.example/fossah/publish", "id": "s"},
                {"url": "file:///tmp/local-peer"},
                {"url": "http://evil.example/fossah/publish"},
                {"url": "https://user:secret@second.example/fossah/publish"},
                "http://127.0.0.1:9/fossah/publish",
            ],
            "repos": [{"url": "https://github.com/someone/not-imported"}],
        }
    }
    direct = [{"url": "https://direct.example/fossah/publish", "id": "d"}]
    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls={"http://127.0.0.1:47321/fossah/publish"},
        direct_peers=direct,
        documents=documents,
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert [item.url for item in chosen] == [item.url for item in _select(documents)]
    by_subject = {item["subject"]: item for item in decisions}
    assert by_subject["https://second.example/fossah/publish"]["accepted"] is True
    assert by_subject["https://second.example/fossah/publish"]["reason"] == "https peer URL"
    assert by_subject["http://127.0.0.1:9/fossah/publish"]["reason"] == "http is allowed for loopback"
    assert by_subject["file:///tmp/local-peer"]["accepted"] is False
    assert "file" in by_subject["file:///tmp/local-peer"]["reason"]
    assert by_subject["http://evil.example/fossah/publish"]["reason"] == "second-degree peers must use https"
    assert "user:secret" not in json.dumps(decisions)
    assert any("credentials" in item["reason"] for item in decisions)
    assert all(item["subject"] != "https://github.com/someone/not-imported" for item in decisions)
    low, low_decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://a.example/p"}, {"url": "https://b.example/p"}],
        documents={
            "https://a.example/p": {"peers": [{"url": "https://new.example/p"}]},
            "https://b.example/p": {"peers": [{"url": "https://new.example/p"}]},
        },
        existing_urls=set(),
        heuristic={**HEURISTIC, "min_endorsements": 3},
    )
    assert low == []
    assert low_decisions[0]["reason"] == "needs 3 endorsements, has 2"
    blocked, blocked_decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": [{"url": "https://nope.example/p"}, {"url": "https://direct.example/p"}]}},
        existing_urls=set(),
        heuristic={**HEURISTIC, "blocked_hosts": ["nope.example"], "max_peers": 1, "max_new_peers_per_cycle": 1},
    )
    assert blocked == []
    reasons = {item["subject"]: item["reason"] for item in blocked_decisions}
    assert reasons["https://nope.example/p"] == "host is blocked"
    assert reasons["https://direct.example/p"] == "already a peer"
    open_http, open_decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": ["http://plain.example/p"]}},
        existing_urls=set(),
        heuristic={**HEURISTIC, "require_https": False},
    )
    assert [item.url for item in open_http] == ["http://plain.example/p"]
    assert open_decisions[0]["reason"] == "http peer URL"
    closed, closed_decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": ["http://127.0.0.1:9/fossah/publish"]}},
        existing_urls=set(),
        heuristic={**HEURISTIC, "allow_insecure_loopback": False},
    )
    assert closed == []
    assert closed_decisions[0]["reason"] == "second-degree peers must use https"
    many = {
        "https://direct.example/p": {
            "peers": [{"url": f"https://peer-{index}.example/p"} for index in range(3)]
        }
    }
    kept, kept_decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents=many,
        existing_urls=set(),
        heuristic={**HEURISTIC, "max_new_peers_per_cycle": 1},
    )
    assert len(kept) == 1
    assert sum(item["reason"] == "the peer cap was reached" for item in kept_decisions) == 2


def test_unsupported_peer_scheme_is_refused() -> None:
    allowed, reason = explain_peer_url("ftp://files.example/fossah/publish", HEURISTIC)
    assert allowed is False
    assert "ftp" in reason


def test_user_added_peer_skips_the_second_degree_check(tmp_path) -> None:
    from fossah.config import ensure_home
    from fossah.peers import user_add_peer

    home = tmp_path / "home"
    ensure_home(home)
    stored = user_add_peer(home, "http://plain.example/fossah/publish")
    assert stored == "http://plain.example/fossah/publish"
    assert not (home / "trust.json").exists()


def test_min_endorsements_and_caps() -> None:
    one = {
        "https://a.example/p": {"peers": [{"url": "https://new.example/p"}]},
    }
    assert _select(one, {**HEURISTIC, "min_endorsements": 2}) == []
    two = {
        "https://a.example/p": {"peers": [{"url": "https://new.example/p"}]},
        "https://b.example/p": {"peers": [{"url": "https://new.example/p"}, {"url": "https://new.example/p"}]},
    }
    direct = [
        {"url": "https://a.example/p"},
        {"url": "https://b.example/p"},
    ]
    chosen = _select(two, {**HEURISTIC, "min_endorsements": 2}, direct=direct)
    assert len(chosen) == 1
    assert chosen[0].endorsements == 2
    capped = _select(two, {**HEURISTIC, "max_peers": 2}, existing=["https://a.example/p", "https://b.example/p"], direct=direct)
    assert capped == []


def test_host_lists_and_self_are_skipped() -> None:
    documents = {
        "https://direct.example/fossah/publish": {
            "peers": [
                {"url": "https://ok.example/p", "id": "ok"},
                {"url": "https://nope.example/p"},
                {"url": "https://self.example/p", "id": "self"},
                {"url": "https://user:pw@ok.example/p"},
            ]
        }
    }
    chosen = _select(
        documents,
        {**HEURISTIC, "allowed_hosts": ["ok.example"], "blocked_hosts": ["nope.example"]},
    )
    assert [item.url for item in chosen] == ["https://ok.example/p"]
    assert peer_url_allowed("https://user:secret@ok.example/p", HEURISTIC) is False
    assert normalize_peer_url("https://OK.Example/fossah/publish/") == "https://ok.example/fossah/publish"
