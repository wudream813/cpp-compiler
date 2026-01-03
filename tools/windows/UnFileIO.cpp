#include<iostream>
#include<limits.h>
#include<cstring>
#include<fstream>

using namespace std;

int main(int argc, char* argv[]) {
    SetConsoleOutputCP(CP_UTF8);
    if (argc != 4) {
        printf("用法：UnFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }
    ofstream out(argv[2]);
    for(string r; getline(cin, r);) {
        out << r << '\n';
    }
    out.close();
    system(argv[1]);
    string command = "copy ";
    command += argv[3];
    command += " con>nul";
    system(command.c_str());
    command = "del /f ";
    command += argv[3];
    system(command.c_str());
    command = "del /f ";
    command += argv[2];
    system(command.c_str());
    return 0;
}
