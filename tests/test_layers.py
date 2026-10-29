"""Personal layer: ~/.config/protect-context merged under the project store.

SPEC §2 layer order is `built-in defaults < personal layer < project store`.
The personal layer is owner-only surface: it is never seeded and never
repaired automatically.
"""

import json

from protect_context import contract, layers, store
from protect_context.defaults import DEFAULT_CONFIG, DEFAULT_CONTRACT


def _write(path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload), encoding="utf-8")


def _row(cid, text, source="user"):
    return {"id": cid, "text": text, "added": "2026-10-30", "source": source}


def test_personal_constraint_applies_to_every_project(user_layer):
    _write(user_layer / "contract.json", {"version": 1, "constraints": [_row("13-my-rule", "Prefer boring technology.")]})
    cons = contract.load()
    assert [c["id"] for c in cons] == [c["id"] for c in DEFAULT_CONTRACT] + ["13-my-rule"]
    # The personal row is NOT copied into the project file.
    on_disk = json.loads(store.contract_path().read_text(encoding="utf-8"))
    assert [c["id"] for c in on_disk["constraints"]] == [c["id"] for c in DEFAULT_CONTRACT]


def test_project_overrides_personal_by_id(user_layer):
    _write(
        user_layer / "contract.json",
        {"version": 1, "constraints": [_row("03-stay-in-scope", "Personal wording of scope.")]},
    )
    cons = contract.load()
    texts = {c["id"]: c["text"] for c in cons}
    assert texts["03-stay-in-scope"].startswith("Change only files")
    assert len(cons) == len(DEFAULT_CONTRACT), "the personal row is shadowed, not appended"


def test_identical_personal_text_is_not_duplicated(user_layer):
    seed_text = DEFAULT_CONTRACT[0]["text"]
    _write(user_layer / "contract.json", {"version": 1, "constraints": [_row("99-dup", seed_text)]})
    cons = contract.load()
    assert [c["text"] for c in cons].count(seed_text) == 1
    assert len(cons) == len(DEFAULT_CONTRACT)


def test_corrupt_personal_layer_is_ignored_and_preserved(user_layer):
    _write(user_layer / "contract.json", "{not json")
    cons = contract.load()
    assert [c["id"] for c in cons] == [c["id"] for c in DEFAULT_CONTRACT]
    assert (user_layer / "contract.json").read_text(encoding="utf-8") == "{not json"


def test_missing_personal_layer_is_never_created():
    assert not layers.user_dir().exists()
    contract.load()
    store.load_config()
    assert not layers.user_dir().exists(), "reading must not seed personal surface"


def test_add_numbers_after_personal_layer_and_skips_personal_duplicates(user_layer):
    _write(
        user_layer / "contract.json",
        {
            "version": 1,
            "constraints": [
                _row("40-personal", "Personal rule forty."),
                _row("41-other", "Shared preference."),
            ],
        },
    )
    added, cons = contract.add("Shared preference.")
    assert added is None, "a personal constraint is not duplicated into the project"
    assert [c["id"] for c in cons][-2:] == ["40-personal", "41-other"]

    added, cons = contract.add("Project-specific rule.")
    assert added is not None
    assert added["id"] == "42-project-specific-rule"
    assert "42-project-specific-rule" in [c["id"] for c in cons]
    assert [c["id"] for c in cons][-2:] == ["40-personal", "41-other"], (
        "project rows first, personal rows appended"
    )
    on_disk = json.loads(store.contract_path().read_text(encoding="utf-8"))
    assert [c["id"] for c in on_disk["constraints"]][-1] == "42-project-specific-rule"


def test_personal_config_is_the_weaker_layer(user_layer):
    _write(user_layer / "config.json", {"ctx_warn_pct": 55, "risk_confirm": False, "loop_block_after": 2})
    cfg = store.load_config()
    assert cfg["ctx_warn_pct"] == 55
    assert cfg["risk_confirm"] is False
    assert cfg["loop_block_after"] == 2
    assert cfg["brief_mode"] == DEFAULT_CONFIG["brief_mode"], "untouched keys still default"

    _write(store.config_path(), {"ctx_warn_pct": 66})
    cfg = store.load_config()
    assert cfg["ctx_warn_pct"] == 66, "the project overrides the personal layer"
    assert cfg["risk_confirm"] is False, "personal value survives for keys the project omits"


def test_invalid_personal_config_values_fall_back(user_layer):
    _write(user_layer / "config.json", {"ctx_warn_pct": 500, "brief_mode": "sometimes"})
    cfg = store.load_config()
    assert cfg["ctx_warn_pct"] == DEFAULT_CONFIG["ctx_warn_pct"]
    assert cfg["brief_mode"] == DEFAULT_CONFIG["brief_mode"]


def test_seeded_project_config_does_not_shadow_the_personal_layer(user_layer):
    """ensure() seeds every key with its default; those values are "no opinion",
    otherwise a fresh project would ignore the personal layer completely."""
    _write(user_layer / "config.json", {"ctx_warn_pct": 55})
    seeded = json.loads(store.config_path().read_text(encoding="utf-8")) if store.config_path().exists() else {}
    assert seeded in ({}, DEFAULT_CONFIG), "project seed is either empty or the full default snapshot"
    assert store.load_config()["ctx_warn_pct"] == 55


def test_merge_unique_keeps_first_layer_precedence():
    rows = layers.merge_unique(
        ([{"id": "a", "text": "project"}], [{"id": "a", "text": "personal"}, {"id": "b", "text": "personal"}]),
        key=lambda r: r["id"],
        signature=lambda r: r["text"],
    )
    assert rows == [{"id": "a", "text": "project"}, {"id": "b", "text": "personal"}]


def test_global_add_writes_the_personal_layer(user_layer, capsys):
    from protect_context.cli import main

    assert main(["contract", "add", "Prefer stdlib over dependencies.", "--global"]) == 0
    assert "personal layer" in capsys.readouterr().out
    personal = json.loads((user_layer / "contract.json").read_text(encoding="utf-8"))
    assert [c["text"] for c in personal["constraints"]] == ["Prefer stdlib over dependencies."]
    assert "Prefer stdlib over dependencies." in [c["text"] for c in contract.load()]
    # The project file stays a pure seed: nothing personal is copied into it.
    on_disk = json.loads(store.contract_path().read_text(encoding="utf-8"))
    assert [c["id"] for c in on_disk["constraints"]] == [c["id"] for c in DEFAULT_CONTRACT]


def test_global_add_numbers_after_the_project_rows(user_layer):
    add, _ = contract.add("Personal rule.", scope=contract.USER_SCOPE)
    assert add is not None
    assert add["id"] == "13-personal-rule", "ids continue after the project's 12 seeds"
    on_disk = json.loads((user_layer / "contract.json").read_text(encoding="utf-8"))
    assert on_disk["constraints"] == [add]


def test_global_remove_only_touches_the_personal_layer(user_layer):
    add, _ = contract.add("Temporary personal rule.", scope=contract.USER_SCOPE)
    assert add is not None
    assert contract.remove(add["id"], scope=contract.PROJECT_SCOPE) is False, (
        "a project-scope remove cannot delete personal state"
    )
    assert contract.remove(add["id"], scope=contract.USER_SCOPE) is True
    assert not (user_layer / "contract.json").exists() or json.loads(
        (user_layer / "contract.json").read_text(encoding="utf-8")
    )["constraints"] == []


def test_cli_remove_points_at_the_personal_layer(user_layer, capsys):
    from protect_context.cli import main

    add, _ = contract.add("Personal rule to keep.", scope=contract.USER_SCOPE)
    assert add is not None
    capsys.readouterr()
    assert main(["contract", "remove", add["id"]]) == 2
    out = capsys.readouterr().out
    assert "lives in the personal layer" in out
    assert "--global" in out
    assert add["id"] in [c["id"] for c in contract.load()]


def test_unknown_config_keys_survive_each_layer(user_layer):
    store.ensure()
    (user_layer / "config.json").write_text(
        json.dumps({"ctx_warn_pct": 55, "my_knob": "personal", "shared_note": "from-personal"}),
        encoding="utf-8",
    )
    cfg = store.load_config()
    assert cfg["ctx_warn_pct"] == 55
    assert cfg["my_knob"] == "personal", "unknown personal keys are preserved, not dropped"
    assert cfg["shared_note"] == "from-personal"

    (store.guard_dir() / "config.json").write_text(
        json.dumps({"shared_note": "from-project"}), encoding="utf-8"
    )
    cfg = store.load_config()
    assert cfg["shared_note"] == "from-project", "the strongest layer wins per unknown key"
    assert cfg["my_knob"] == "personal", "a project key does not erase unrelated personal extras"
    assert cfg["loop_block_after"] == DEFAULT_CONFIG["loop_block_after"]
