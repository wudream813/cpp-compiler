#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <ctime>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <sys/wait.h>
#include <limits.h>

#ifndef MAX_PATH
#define MAX_PATH PATH_MAX
#endif

using namespace std;

// 辅助函数定义同上 (removeDir, createTempSubDir, writeStdinToFile)
void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (!d) { rmdir(path); return; }
    struct dirent* p;
    while ((p = readdir(d))) {
        if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
        char buf[MAX_PATH];
        snprintf(buf, sizeof(buf), "%s/%s", path, p->d_name);
        struct stat statbuf;
        if (!stat(buf, &statbuf)) {
            if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
            else unlink(buf);
        }
    }
    closedir(d);
    rmdir(path);
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    string baseStr = base;
    if (baseStr.back() == '/') baseStr.pop_back();

    char parentDir[MAX_PATH];
    snprintf(parentDir, MAX_PATH, "%s/dream-cpp-compiler", baseStr.c_str());
    mkdir(parentDir, 0755);

    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", baseStr.c_str(), (long long)time(NULL));
    return mkdir(tempDir, 0755) == 0 || errno == EEXIST;
}

bool writeStdinToFile(const char* filePath) {
    int fd = open(filePath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return false;
    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
        write(fd, buffer, bytes);
    }
    close(fd);
    return true;
}

int runExe(const char* exePath, const char* workingDir) {
    pid_t pid = fork();
    if (pid == 0) {
        if (workingDir) chdir(workingDir);
        execl("/bin/sh", "sh", "-c", exePath, NULL);
        exit(127);
    }
    int status;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

int main(int argc, char* argv[]) {
    if (argc != 4) {
        printf("用法：UnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }

    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) return -1;

    snprintf(tempInput, MAX_PATH, "%s/%s", tempDir, argv[2]);
    snprintf(tempOutput, MAX_PATH, "%s/%s", tempDir, argv[3]);

    if (!writeStdinToFile(tempInput)) {
        removeDir(tempDir);
        return -1;
    }

    int ret = runExe(argv[1], tempDir);

    // 读取输出文件写回 stdout
    int fdOut = open(tempOutput, O_RDONLY);
    if (fdOut >= 0) {
        char buffer[4096];
        ssize_t bytes;
        while ((bytes = read(fdOut, buffer, sizeof(buffer))) > 0) {
            write(STDOUT_FILENO, buffer, bytes);
        }
        close(fdOut);
    } else {
        printf("错误：无法打开输出文件");
    }

    removeDir(tempDir);
    return ret;
}
