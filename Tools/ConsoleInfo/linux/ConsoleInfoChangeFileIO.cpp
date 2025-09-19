#include <iostream>
#include <cstring>
#include <cstdlib>

using namespace std;

int main(int argc, char* argv[]) {
	if (argc != 6) {
		printf("用法：ConsoleInfoChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
		return -1;
	}

	string command;
	bool copied = false;

	// 如果 PrograminputFile 与 WillinputFile 不同，则复制
	if (strcmp(argv[2], argv[4]) != 0) {
		command = "cp -f ";
		command += argv[4];
		command += " ";
		command += argv[2];
		system(command.c_str());
		copied = true;
	}

	// 调用 ConsoleInfo（Linux 版本）
	command = "./ConsoleInfo ";
	command += argv[1];
	system(command.c_str());

	// 如果之前复制过输入文件，则删除
	if (copied) {
		command = "rm -f ";
		command += argv[2];
		system(command.c_str());
	}

	// 移动输出文件
	command = "mv -f ";
	command += argv[3];
	command += " ";
	command += argv[5];
	system(command.c_str());

	return 0;
}
