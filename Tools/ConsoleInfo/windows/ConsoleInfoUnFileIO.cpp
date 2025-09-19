#include<iostream>
#include<limits.h>
#include<cstring>
#include<fstream>

using namespace std;

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("”√∑®£∫ConsoleInfoUnFileIO.exe <command> <inputFile> <outputFile>\n");
        return -1;
    }
    ofstream out(argv[2]);
    for(string r; getline(cin, r);) {
        out << r << '\n';
    }
    out.close();
    string command = "ConsoleInfo.exe ";
    command += argv[1];
    command += ">.ConsoleInfo.out";
    system(command.c_str());
    command = "copy ";
    command += argv[3];
    command += " con>nul";
    system(command.c_str());
    system("copy .ConsoleInfo.out con>nul");
    command = "del /f ";
    command += argv[3];
    system(command.c_str());
    command = "del /f ";
    command += argv[2];
    system(command.c_str());
    system("del /f .ConsoleInfo.out");
    return 0;
}
    