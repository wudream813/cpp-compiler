#include <iostream>
#include <cstring>
#include <cstdlib>
#include <string>

using namespace std;

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("用法：ChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    string programIn = argv[2];
    string programOut = argv[3];
    string willIn = argv[4];
    string willOut = argv[5];

    // 若输入文件不同则复制
    if (strcmp(argv[2], argv[4]) != 0) {
        string cmd = "cp ";
        cmd += willIn + " " + programIn;
        system(cmd.c_str());
    }

    // 执行命令
    system(argv[1]);

    // 删除中间输入文件
    if (strcmp(argv[2], argv[4]) != 0) {
        string delCmd = "rm -f ";
        delCmd += programIn;
        system(delCmd.c_str());
    }

    // 移动输出文件
    string moveCmd = "mv ";
    moveCmd += programOut + " " + willOut;
    system(moveCmd.c_str());

    return 0;
}
