"""A missing generated source must not hide Manim's actual failure."""

from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest

from deeptutor.agents.math_animator import renderer
from deeptutor.agents.math_animator.renderer import ManimRenderError, ManimRenderService


@pytest.mark.asyncio
async def test_failed_manim_preserves_stderr_when_source_disappears(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    class FailedProcess:
        stdout = BytesIO(b"")
        stderr = BytesIO(b"FileNotFoundError: latex compiler missing\n")

        def wait(self) -> int:
            return 1

    monkeypatch.setattr(
        "deeptutor.agents.math_animator.renderer.subprocess.Popen",
        lambda *_args, **_kwargs: FailedProcess(),
    )
    service = ManimRenderService("test", output_dir=tmp_path)

    with pytest.raises(ManimRenderError, match="latex compiler missing"):
        await service._run_manim(
            code_path=tmp_path / "missing_scene.py",
            scene_name="TestScene",
            quality="low",
            save_last_frame=False,
            media_dir=service.media_dir,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ManimRenderError, asyncio.CancelledError])
async def test_windows_staging_is_cleaned_before_retry(monkeypatch, tmp_path, failure):
    monkeypatch.setattr(renderer, "os", SimpleNamespace(name="nt"))
    workspace = tmp_path / ("a" * 121)
    service = ManimRenderService("test", output_dir=workspace, workspace_root=workspace)
    staged: list[Path] = []

    async def fake_manim(*, media_dir: Path, **kwargs):
        assert media_dir.is_dir()
        assert media_dir != service.media_dir
        staged.append(media_dir)
        (media_dir / "TestScene.mp4").write_bytes(b"output")
        if len(staged) == 1:
            raise failure("render interrupted")

    monkeypatch.setattr(service, "_run_manim", fake_manim)
    code = "class TestScene(Scene):\n    pass"
    with pytest.raises(failure, match="render interrupted"):
        await service.render(code=code, output_mode="video", quality="low")
    assert not staged[0].exists()

    result = await service.render(code=code, output_mode="video", quality="low")
    assert staged[0] != staged[1]
    assert not staged[1].exists()
    assert (workspace / result.artifacts[0].relative_path).read_bytes() == b"output"
