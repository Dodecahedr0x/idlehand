import json

import pytest

from idlehand.peers import explain_peer_url, normalize_peer_url, peer_url_allowed, review_second_degree, select_second_degree

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
    direct_peers = direct or [{"url": "https://direct.example/idlehand/publish", "id": "d"}]
    return select_second_degree(
        self_id=self_id,
        self_urls={"http://127.0.0.1:47321/idlehand/publish"},
        direct_peers=direct_peers,
        documents=documents,
        existing_urls=set(existing or []),
        heuristic=heuristic or HEURISTIC,
    )


def test_one_endorsement_adds_a_peer_and_not_a_file_url() -> None:
    documents = {
        "https://direct.example/idlehand/publish": {
            "peers": [
                {"url": "https://second.example/idlehand/publish", "id": "s"},
                {"url": "file:///tmp/secret"},
                {"url": "http://evil.example/idlehand/publish"},
                "http://127.0.0.1:9/idlehand/publish",
            ],
            "repos": [{"url": "https://github.com/someone/repo"}],
        }
    }
    chosen = _select(documents)
    urls = [item.url for item in chosen]
    assert "https://second.example/idlehand/publish" in urls
    assert "http://127.0.0.1:9/idlehand/publish" in urls
    assert all(not url.startswith("file:") for url in urls)
    assert all("evil.example" not in url for url in urls)


def test_review_explains_each_peer_and_does_not_import_repos() -> None:
    documents = {
        "https://direct.example/idlehand/publish": {
            "peers": [
                {"url": "https://second.example/idlehand/publish", "id": "s"},
                {"url": "file:///tmp/local-peer"},
                {"url": "http://evil.example/idlehand/publish"},
                {"url": "https://user:secret@second.example/idlehand/publish"},
                "http://127.0.0.1:9/idlehand/publish",
            ],
            "repos": [{"url": "https://github.com/someone/not-imported"}],
        }
    }
    direct = [{"url": "https://direct.example/idlehand/publish", "id": "d"}]
    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls={"http://127.0.0.1:47321/idlehand/publish"},
        direct_peers=direct,
        documents=documents,
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert [item.url for item in chosen] == [item.url for item in _select(documents)]
    by_subject = {item["subject"]: item for item in decisions}
    assert by_subject["https://second.example/idlehand/publish"]["accepted"] is True
    assert by_subject["https://second.example/idlehand/publish"]["reason"] == "https peer URL"
    assert by_subject["http://127.0.0.1:9/idlehand/publish"]["reason"] == "http is allowed for loopback"
    assert by_subject["file:///tmp/local-peer"]["accepted"] is False
    assert "file" in by_subject["file:///tmp/local-peer"]["reason"]
    assert by_subject["http://evil.example/idlehand/publish"]["reason"] == "second-degree peers must use https"
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
        documents={"https://direct.example/p": {"peers": ["http://127.0.0.1:9/idlehand/publish"]}},
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


def test_bad_endorsement_count_is_skipped(tmp_path) -> None:
    from idlehand.config import ensure_home, load_peers, peers_path

    home = tmp_path / "home"
    ensure_home(home)
    peers_path(home).write_text(
        "[[peers]]\n"
        'url = "https://bad.example/idlehand/publish"\n'
        'endorsements = "no"\n'
        "\n"
        "[[peers]]\n"
        'url = "https://good.example/idlehand/publish"\n'
        "endorsements = 2\n",
        encoding="utf-8",
    )
    loaded = load_peers(home)
    assert [item["url"] for item in loaded] == [
        "https://bad.example/idlehand/publish",
        "https://good.example/idlehand/publish",
    ]
    assert loaded[0]["endorsements"] == 1
    assert loaded[1]["endorsements"] == 2


def test_non_boolean_heuristic_flags_do_not_open_http() -> None:
    allowed, reason = explain_peer_url(
        "http://127.0.0.1:9/idlehand/publish",
        {**HEURISTIC, "allow_insecure_loopback": "false"},
    )
    assert allowed is False
    assert reason == "peer heuristic is unreadable"
    opened, opened_reason = explain_peer_url(
        "http://plain.example/idlehand/publish",
        {**HEURISTIC, "require_https": ""},
    )
    assert opened is False
    assert opened_reason == "peer heuristic is unreadable"
    listed, listed_reason = explain_peer_url(
        "https://ok.example/p",
        {**HEURISTIC, "blocked_hosts": "no"},
    )
    assert listed is False
    assert listed_reason == "peer heuristic is unreadable"


def test_peer_url_with_a_newline_is_refused() -> None:
    allowed, reason = explain_peer_url("https://peer.example/idlehand/publish\nsekret", HEURISTIC)
    assert allowed is False
    assert "newline" in reason
    assert "sekret" not in reason
    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": ["https://peer.example/p\nsekret"]}},
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert chosen == []
    assert "sekret" not in json.dumps(decisions)


def test_ipv6_loopback_keeps_its_brackets() -> None:
    assert normalize_peer_url("https://[::1]/idlehand/publish") == "https://[::1]/idlehand/publish"
    assert normalize_peer_url("https://[::1]:47321/idlehand/publish/") == "https://[::1]:47321/idlehand/publish"
    allowed, reason = explain_peer_url("http://[::1]:9/idlehand/publish", HEURISTIC)
    assert allowed is True
    assert reason == "http is allowed for loopback"
    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": ["http://[::1]:9/idlehand/publish"]}},
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert [item.url for item in chosen] == ["http://[::1]:9/idlehand/publish"]
    assert decisions[-1]["accepted"] is True
    assert decisions[-1]["subject"] == "http://[::1]:9/idlehand/publish"


def test_unsupported_peer_scheme_is_refused() -> None:
    allowed, reason = explain_peer_url("ftp://files.example/idlehand/publish", HEURISTIC)
    assert allowed is False
    assert "ftp" in reason


def test_token_query_on_a_peer_url_is_refused(tmp_path) -> None:
    from idlehand.config import ensure_home
    from idlehand.peers import user_add_peer

    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={
            "https://direct.example/p": {
                "peers": [{"url": "https://second.example/p?token=sekret"}],
                "repos": [{"url": "https://github.com/someone/not-imported"}],
            }
        },
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert chosen == []
    blob = json.dumps(decisions)
    assert "sekret" not in blob
    assert "token=" not in blob
    assert any("credentials" in item["reason"] and item["accepted"] is False for item in decisions)
    assert all("github.com" not in item["subject"] for item in decisions)
    home = tmp_path / "home"
    ensure_home(home)
    with pytest.raises(ValueError, match="credentials"):
        user_add_peer(home, "https://peer.example/idlehand/publish?access_token=sekret")
    assert "sekret" not in (home / "peers.toml").read_text(encoding="utf-8")
    assert not (home / "trust.json").exists()


def test_user_added_peer_skips_the_second_degree_check(tmp_path) -> None:
    from idlehand.config import ensure_home
    from idlehand.peers import user_add_peer

    home = tmp_path / "home"
    ensure_home(home)
    stored = user_add_peer(home, "http://plain.example/idlehand/publish")
    assert stored == "http://plain.example/idlehand/publish"
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
        "https://direct.example/idlehand/publish": {
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
    assert normalize_peer_url("https://OK.Example/idlehand/publish/") == "https://ok.example/idlehand/publish"


def test_unsupported_peer_scheme_does_not_keep_the_raw_url(tmp_path) -> None:
    from idlehand.analytics import render_text
    from idlehand.config import ensure_home, save_config, save_peers
    from idlehand.loop import tick

    assert explain_peer_url("password=sekret", HEURISTIC) == (False, "peer URLs cannot embed credentials")
    encoded = "https://user%25253Asekret%252540peer.example/idlehand/publish"
    assert explain_peer_url(encoded, HEURISTIC) == (False, "peer URLs cannot embed credentials")
    chosen, decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": [encoded], "repos": []}},
        existing_urls=set(),
        heuristic=HEURISTIC,
    )
    assert chosen == []
    assert "sekret" not in json.dumps(decisions)
    assert explain_peer_url("ssh://git.example/org/repo", HEURISTIC) == (False, "unsupported peer URL scheme: ssh")
    home = tmp_path / "home"
    config = ensure_home(home)
    config["publish"]["peer_fetch_interval_seconds"] = 0
    save_config(home, config)
    peer = tmp_path / "peer.json"
    peer.write_text(
        json.dumps({"peers": ["password=sekret", "ssh://git.example/org/repo"], "repos": []}),
        encoding="utf-8",
    )
    save_peers(home, [{"url": peer.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    state = tick(home)
    blob = json.dumps(state) + (home / "trust.json").read_text(encoding="utf-8") + render_text(home)
    assert "sekret" not in blob
    assert "unsupported peer URL scheme" in blob
    assert "unsupported peer URL scheme: ssh" in blob
