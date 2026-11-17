"""Stable section identifiers for the five indexed PEP A mathematics volumes."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
import re


@dataclass(frozen=True)
class Section:
    id: str
    number: str
    title: str


@dataclass(frozen=True)
class Chapter(Section):
    sections: tuple[Section, ...]


@dataclass(frozen=True)
class Volume:
    id: str
    title: str
    chapters: tuple[Chapter, ...]


@dataclass(frozen=True)
class Curriculum:
    edition: str
    volumes: tuple[Volume, ...]


# Main sections follow the locally indexed 人教A版 tables of contents. Include
# the finer locators already used by the local textbook tagging workflow.
_BOOKS = (
    (
        "b1",
        "必修第一册",
        """
1 集合与常用逻辑用语
1.1 集合的概念
1.2 集合间的基本关系
1.3 集合的基本运算
1.4 充分条件与必要条件
1.5 全称量词与存在量词
2 一元二次函数、方程和不等式
2.1 等式性质与不等式性质
2.2 基本不等式
2.3 二次函数与一元二次方程、不等式
3 函数的概念与性质
3.1 函数的概念及其表示
3.1.2 函数的表示法
3.2 函数的基本性质
3.3 幂函数
3.4 函数的应用（一）
4 指数函数与对数函数
4.1 指数
4.2 指数函数
4.2.1 指数函数的概念
4.2.2 指数函数的图象和性质
4.3 对数
4.3.1 对数的概念
4.3.2 对数的运算
4.4 对数函数
4.4.1 对数函数的概念
4.4.2 对数函数的图象和性质
4.5 函数的应用（二）
4.5.1 函数的零点与方程的解
4.5.2 用二分法求方程的近似解
4.5.3 函数模型的应用
5 三角函数
5.1 任意角和弧度制
5.2 三角函数的概念
5.3 诱导公式
5.4 三角函数的图象与性质
5.5 三角恒等变换
5.6 函数 y=Asin(ωx+φ)
5.7 三角函数的应用
""",
    ),
    (
        "b2",
        "必修第二册",
        """
6 平面向量及其应用
6.1 平面向量的概念
6.2 平面向量的运算
6.3 平面向量基本定理及坐标表示
6.4 平面向量的应用
6.4.3 余弦定理、正弦定理
7 复数
7.1 复数的概念
7.2 复数的四则运算
7.3 复数的三角表示
8 立体几何初步
8.1 基本立体图形
8.2 立体图形的直观图
8.3 简单几何体的表面积与体积
8.4 空间点、直线、平面之间的位置关系
8.5 空间直线、平面的平行
8.6 空间直线、平面的垂直
9 统计
9.1 随机抽样
9.2 用样本估计总体
9.3 统计案例：公司员工的肥胖情况调查分析
10 概率
10.1 随机事件与概率
10.2 事件的相互独立性
10.3 频率与概率
""",
    ),
    (
        "x1",
        "选择性必修第一册",
        """
1 空间向量与立体几何
1.1 空间向量及其运算
1.2 空间向量基本定理
1.3 空间向量及其运算的坐标表示
1.4 空间向量的应用
2 直线和圆的方程
2.1 直线的倾斜角与斜率
2.2 直线的方程
2.3 直线的交点坐标与距离公式
2.4 圆的方程
2.5 直线与圆、圆与圆的位置关系
3 圆锥曲线的方程
3.1 椭圆
3.2 双曲线
3.3 抛物线
""",
    ),
    (
        "x2",
        "选择性必修第二册",
        """
4 数列
4.1 数列的概念
4.2 等差数列
4.3 等比数列
4.4 数学归纳法
5 一元函数的导数及其应用
5.1 导数的概念及其意义
5.2 导数的运算
5.3 导数在研究函数中的应用
""",
    ),
    (
        "x3",
        "选择性必修第三册",
        """
6 计数原理
6.1 分类加法计数原理与分步乘法计数原理
6.2 排列与组合
6.3 二项式定理
7 随机变量及其分布
7.1 条件概率与全概率公式
7.2 离散型随机变量及其分布列
7.3 离散型随机变量的数字特征
7.4 二项分布与超几何分布
7.5 正态分布
8 成对数据的统计分析
8.1 成对数据的统计相关性
8.2 一元线性回归模型及其应用
8.3 列联表与独立性检验
""",
    ),
)


def _build_volume(volume_id: str, title: str, contents: str) -> Volume:
    chapters: dict[str, str] = {}
    sections: dict[str, list[Section]] = {}
    for line in contents.strip().splitlines():
        number, heading = line.split(maxsplit=1)
        chapter_number, _, subsection = number.partition(".")
        if subsection:
            sections.setdefault(chapter_number, []).append(
                Section(f"{volume_id}-{number}", number, heading)
            )
        else:
            chapters[number] = heading
    return Volume(
        volume_id,
        title,
        tuple(
            Chapter(f"{volume_id}-{number}", number, heading, tuple(sections[number]))
            for number, heading in chapters.items()
        ),
    )


_CURRICULUM = Curriculum("人教A版 · 高中数学", tuple(_build_volume(*book) for book in _BOOKS))
_VOLUME_IDS = {volume.id for volume in _CURRICULUM.volumes}
_VOLUME_BY_TITLE = {volume.title: volume.id for volume in _CURRICULUM.volumes}
_SECTION_IDS = {
    node.id
    for volume in _CURRICULUM.volumes
    for chapter in volume.chapters
    for node in (chapter, *chapter.sections)
}
_LEGACY_TAG = re.compile(
    r"^教材·(?P<book>\S+)\s+(?:§(?P<section>[0-9]+(?:\.[0-9]+)+)|第(?P<chapter>[0-9]+)章)(?:\s|$)"
)


def get_curriculum() -> Curriculum:
    return _CURRICULUM


def is_textbook_section_id(section_id: str) -> bool:
    return section_id in _SECTION_IDS


def is_textbook_node_id(node_id: str) -> bool:
    return node_id in _VOLUME_IDS or is_textbook_section_id(node_id)


def textbook_section_from_legacy_tags(tags: Iterable[str]) -> str | None:
    """A single recognized textbook locator can be migrated without a guess."""
    candidates: set[str] = set()
    for tag in tags:
        match = _LEGACY_TAG.match(tag.strip())
        if match and (volume_id := _VOLUME_BY_TITLE.get(match["book"])):
            section_id = f"{volume_id}-{match['section'] or match['chapter']}"
            if is_textbook_section_id(section_id):
                candidates.add(section_id)
    return candidates.pop() if len(candidates) == 1 else None
