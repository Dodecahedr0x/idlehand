from fossah.peers import normalize_peer_url, peer_url_allowed, select_second_degree

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
