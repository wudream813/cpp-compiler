#include <iostream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <ctime>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <copyfile.h> // macOS 专用文件复制库
#include <sys/wait.h>
#include <limits.h>

#ifndef MAX_PATH
#define MAX_PATH PATH_MAX
#endif

using namespace std;

// 递归删除目录
void removeDir(const char* path) {
    DIR* d = opendir(path);
    size_t path_len = strlen(path);
    int r = -1;

    if (d) {
        struct dirent* p;
        r = 0;
        while (!r && (p = readdir(d))) {
            int r2 = -1;
            char* buf;
            size_t len;

            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, ".."))
                continue;

            len = path_len + strlen(p->d_name) + 2;
            buf = (char*)malloc(len);

            if (buf) {
                struct stat statbuf;
                snprintf(buf, len, "%s/%s", path, p->d_name);
                if (!stat(buf, &statbuf)) {
                    if (S_ISDIR(statbuf.st_mode))
                        removeDir(buf);
                    else
                        unlink(buf);
                }
                free(buf);
            }
        }
        closedir(d);
    }
    rmdir(path);
}

// macOS 文件拷贝
bool copyFileMac(const char* src, const char* dst) {
    // COPYFILE_ALL 复制数据、元数据、扩展属性等
    return copyfile(src, dst, NULL, COPYFILE_ALL) == 0;
}

// 创建临时目录
bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";

    // 移除末尾斜杠
    string baseStr = base;
    if (baseStr.back() == '/') baseStr.pop_back();

    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", baseStr.c_str(), (long long)time(NULL));

    // mkdir -p 逻辑需要逐级创建，这里简化处理，假设 parent 存在或者仅创建最后一级
    // 为保险起见，先尝试创建父目录
    char parentDir[MAX_PATH];
    snprintf(parentDir, MAX_PATH, "%s/dream-cpp-compiler", baseStr.c_str());
    mkdir(parentDir, 0755);

    return mkdir(tempDir, 0755) == 0 || errno == EEXIST;
}

// 执行命令
int runExe(const char* exePath, const char* workingDir) {
    pid_t pid = fork();
    if (pid == 0) {
        // Child
        if (workingDir) {
            chdir(workingDir);
        }
        // 使用 sh -c 来执行命令字符串，模拟 Windows 行为
        execl("/bin/sh", "sh", "-c", exePath, NULL);
        exit(127); // Exec 失败
    } else if (pid > 0) {
        // Parent
        int status;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status)) {
            return WEXITSTATUS(status);
        }
    }
    return -1;
}

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("用法：ChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH];

    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    snprintf(tempInput, MAX_PATH, "%s/%s", tempDir, willInput);
    snprintf(tempOutput, MAX_PATH, "%s/%s", tempDir, willOutput);

    if (!copyFileMac(programInput, tempInput)) {
        printf("无法复制输入文件到临时目录\n");
        removeDir(tempDir);
        return -1;
    }

    int ret = runExe(commandArg, tempDir);

    copyFileMac(tempOutput, programOutput);

    removeDir(tempDir);

    return ret;
}
