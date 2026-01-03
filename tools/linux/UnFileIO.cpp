#include <iostream>
#include <fstream>
#include <string>
#include <cstdlib>

using namespace std;

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：UnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    // 将输入写入文件
    ofstream out(argv[2]);
    string line;
    while (getline(cin, line)) {
        out << line << '\n';
    }
    out.close();

    // 执行命令
    system(argv[1]);

    // 输出文件到终端
    string copyCmd = "cat ";
    copyCmd += argv[3];
    system(copyCmd.c_str());

    // 删除文件
    string delCmd = "rm -f ";
    delCmd += argv[2];
    system(delCmd.c_str());
    delCmd = "rm -f ";
    delCmd += argv[3];
    system(delCmd.c_str());

    return 0;
}
