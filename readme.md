<h1 align=center> Dream cpp compiler </h1>

<p align=center>让你方便快速的在 vscode 中编译运行 C++ 文件</p>

<div align=center>
    <img alt="VS Code" src="https://img.shields.io/badge/VSCode-7d57c2?style=for-the-badge"/>
    <img alt="C++" src="https://img.shields.io/badge/C%2B%2B-7d57c2?style=for-the-badge&logo=c%2B%2B&logoColor=white"/>
</div>

<div align=center>
    <img alt="下载量" src="https://img.shields.io/visual-studio-marketplace/d/wudream.dream-cpp-compiler?style=for-the-badge&color=064f8c&link=https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler">
    <img alt="版本" src="https://img.shields.io/visual-studio-marketplace/v/wudream.dream-cpp-compiler?style=for-the-badge&color=be2128&link=https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler">
    <img alt="安装量" src="https://img.shields.io/visual-studio-marketplace/i/wudream.dream-cpp-compiler?style=for-the-badge&color=249847&link=https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler">
    <img alt="star 数" src="https://img.shields.io/github/stars/wudream813/cpp-compiler?style=for-the-badge&color=551A8B&link=https://github.com/wudream813/cpp-compiler">
    <img alt="评分" src="https://img.shields.io/visual-studio-marketplace/stars/wudream.dream-cpp-compiler?style=for-the-badge&color=9400d3&link=https://marketplace.visualstudio.com/items?itemName=wudream.dream-cpp-compiler">
</div>

# 功能
- 编译、运行 C++ 程序
- 智能编译（记录 Hash 避免重编译，提升编译效率）
- 侧边栏进行编译
- 右键快捷编译
- 状态栏快捷编译
- 快捷文件读写
- 支持所有操作系统
- 非 macOS 支持使用 ConsoleInfo.exe 进行输出，还支持反文件读写
- 自定义编译选项
- 设置编译器路径
- 增强资源管理器

<details open>
<summary>
 与普通 C/C++ 插件对比
</summary><br/>
<table>
<tr>
<th>功能</th>
<th>C/C++</th>
<th>dream-cpp-compiler</th>
</tr>
<tr>
<td>编译且运行 C++ 程序</td>
<td>✅</td>
<td>✅</td>
</tr>
<tr>
<td>调试 C++ 程序</td>
<td>✅</td>
<td>❌</td>
</tr>
<tr>
<td>设置 C++ 程序编译选项</td>
<td>⚠️需要配置 tasks.json</td>
<td>✅</td>
</tr>
<tr>
<td>仅编译 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>中文路径编译、运行 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr title="记录 Hash 值，避免无用重编译">
<td>智能编译 C++ 程序</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>详细显示运行时间（即 ConsoleInfo）</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行文件重定向</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行反文件重定向</td>
<td>❌</td>
<td>✅</td>
</tr>
<tr>
<td>进行对每个文件独立设置编译选项</td>
<td>❌</td>
<td>✅</td>
</tr>
</table>
</details>

<details open>
<summary>
 警告
</summary><br/>
<strong>由于编译器设置的特殊性，因此只在用户设置中生效，工作区的设置不会被拓展使用</strong>
</details>
