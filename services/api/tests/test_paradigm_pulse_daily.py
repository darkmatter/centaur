from workflows.paradigm_pulse_daily import _slackify_links


def test_slackify_links_converts_markdown_and_bare_urls() -> None:
    text = (
        "*News*\n"
        "- Read [Paradigm Fellowship](https://paradigm.xyz/fellowship-2026), "
        "keep <https://x.com/tempo/status/1|@tempo> as-is, and watch "
        "https://x.com/notawizard/status/1234567890.\n"
        "- More signal from https://x.com/andyfang/status/456 and "
        "https://tempo.xyz/customer-stories/karta\n"
    )

    result = _slackify_links(text)

    assert "<https://paradigm.xyz/fellowship-2026|Paradigm Fellowship>" in result
    assert result.count("<https://x.com/tempo/status/1|@tempo>") == 1
    assert "<https://x.com/notawizard/status/1234567890|@notawizard>." in result
    assert "<https://x.com/andyfang/status/456|@andyfang>" in result
    assert "<https://tempo.xyz/customer-stories/karta|tempo.xyz/karta>" in result
