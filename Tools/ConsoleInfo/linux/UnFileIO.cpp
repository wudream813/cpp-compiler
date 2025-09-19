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

	// 把标准输入写入 inputFile
	ofstream out(argv[2]);
	for (string r; getline(cin, r);) {
		out << r << '\n';
	}
	out.close();

	// 执行目标命令
	system(argv[1]);

	// 输出 outputFile 的内容到控制台
	string command = "cat ";
	command += argv[3];
	system(command.c_str());

	// 删除 outputFile
	command = "rm -f ";
	command += argv[3];
	system(command.c_str());

	// 删除 inputFile
	command = "rm -f ";
	command += argv[2];
	system(command.c_str());

	return 0;
}
