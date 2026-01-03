#include<iostream>
#include<limits.h>
#include<cstring>
#include<fstream>

using namespace std;

int main(int argc, char* argv[]) {
	SetConsoleOutputCP(CP_UTF8);
    if (argc != 6) {
        printf("用法：ChangeFileIO.exe <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }
    string command;
    if(strcmp(argv[2], argv[4])) {
        command = "copy /y ";
        command += argv[4];
        command += " ";
        command += argv[2];
        command += ">nul";
        // cout << command << '\n';
        system(command.c_str());
    }
    system(argv[1]);
    if(strcmp(argv[2], argv[4])) {
        string command = "copy /y ";
        command = "del /f ";
        command += argv[2];
        // cout << command << '\n';
        system(command.c_str());
    }
    command = "move /y ";
    command += argv[3];
    command += " ";
    command += argv[5];
    command += ">nul";
    // cout << command << '\n';
    system(command.c_str());
    return 0;
}
