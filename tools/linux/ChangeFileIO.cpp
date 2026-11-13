#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <limits.h>

#include <cctype>
#include <string>
#include <algorithm>

bool isConsoleFile(const char* path) {
    if (!path || !*path) return false;
    std::string p(path);
    std::string lower = p;
    for (char &c : lower) c = std::tolower((unsigned char)c);
    if (lower == "con" || lower == "conin$" || lower == "conout$" || lower == "nul" || lower == "aux" || lower == "prn") return true;
    if (lower == "/dev/stdin" || lower == "/dev/stdout" || lower == "/dev/stderr" || lower == "/dev/tty" || lower == "/dev/console") return true;
    if (lower.rfind("/dev/pts/", 0) == 0) return true;
    size_t sep = p.find_last_of("/\\");
    std::string base = (sep == std::string::npos) ? p : p.substr(sep + 1);
    size_t dot = base.find('.');
    std::string nameNoExt = (dot == std::string::npos) ? base : base.substr(0, dot);
    std::string nameLower = nameNoExt;
    for (char &c : nameLower) c = std::tolower((unsigned char)c);
    const std::string reserved[] = {"con","conin$","conout$","nul","aux","prn","com1","com2","com3","com4","com5","com6","com7","com8","com9","lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"};
    for (auto &r : reserved) if (nameLower == r) return true;
    std::string baseLower = base;
    for (char &c : baseLower) c = std::tolower((unsigned char)c);
    for (auto &r : reserved) if (baseLower == r) return true;
    return false;
}


// 递归删除目录
void removeDir(const char* path) {
    DIR* d = opendir(path);
    if (d) {
        struct dirent* p;
        while ((p = readdir(d))) {
            if (!strcmp(p->d_name, ".") || !strcmp(p->d_name, "..")) continue;
            char buf[PATH_MAX];
            snprintf(buf, PATH_MAX, "%s/%s", path, p->d_name);
            struct stat statbuf;
            if (!lstat(buf, &statbuf)) {
                if (S_ISLNK(statbuf.st_mode)) unlink(buf);
                else if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
                else unlink(buf);
            }
        }
        closedir(d);
    }
    rmdir(path);
}

// 使用 POSIX open/read/write 拷贝文件
bool copyFileLinux(const char* src, const char* dst) {
    int fd_in = open(src, O_RDONLY);
    if (fd_in < 0) return false;

    int fd_out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd_out < 0) {
        close(fd_in);
        return false;
    }

    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(fd_in, buffer, sizeof(buffer))) > 0) {
        if (write(fd_out, buffer, bytes) != bytes) {
            close(fd_in);
            close(fd_out);
            return false;
        }
    }

    close(fd_in);
    close(fd_out);
    return true;
}

bool createTempSubDir(char* tempDir, size_t size) {
    const char* base = getenv("TMPDIR");
    if (!base) base = "/tmp";
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld_%d_%d", base, (long long)time(NULL), (int)getpid(), rand() % 10000);
    return mkdir(tempDir, 0777) == 0;
}


bool writeStdinToFile(const char* filePath) {
    int fd = open(filePath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return false;
    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
        if (write(fd, buffer, bytes) != bytes) { close(fd); return false; }
    }
    close(fd);
    return true;
}

bool dumpFileToStdout(const char* filePath) {
    int fd = open(filePath, O_RDONLY);
    if (fd < 0) return false;
    char buffer[4096];
    ssize_t bytes;
    while ((bytes = read(fd, buffer, sizeof(buffer))) > 0) {
        if (write(STDOUT_FILENO, buffer, bytes) != bytes) { close(fd); return false; }
    }
    close(fd);
    return true;
}

int runExe(const char* exePath, const char* workingDir) {
    pid_t pid = fork();
    if (pid == 0) {
        if (workingDir) chdir(workingDir);
        char* args[] = { (char*)exePath, NULL };
        execvp(exePath, args);
        _exit(127);
    } else if (pid > 0) {
        int status;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status)) return WEXITSTATUS(status);
        return -1;
    }
    return -1;
}

int main(int argc, char* argv[]) {
    if (argc != 6) {
        printf("用法：ChangeFileIO <command> <PrograminputFile> <ProgramoutputFile> <WillinputFile> <WilloutputFile>\n");
        return -1;
    }

    bool progInputIsCon = isConsoleFile(argv[2]);
    bool progOutputIsCon = isConsoleFile(argv[3]);
    bool willInputIsCon = isConsoleFile(argv[4]);
    bool willOutputIsCon = isConsoleFile(argv[5]);
    if (willInputIsCon && willOutputIsCon) {
        return runExe(argv[1], nullptr);
    }
    char tempDir[PATH_MAX], tempInput[PATH_MAX] = {0}, tempOutput[PATH_MAX] = {0};
    bool needTemp = !willInputIsCon || !willOutputIsCon;
    if (needTemp) {
        if (!createTempSubDir(tempDir, sizeof(tempDir))) {
            printf("无法创建临时目录\n");
            return -1;
        }
        if (!willInputIsCon) snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[4]);
        if (!willOutputIsCon) snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[5]);
    } else {
        tempDir[0] = 0;
    }
    if (!willInputIsCon) {
        if (progInputIsCon) {
            if (!writeStdinToFile(tempInput)) {
                printf("无法从控制台读取输入到临时文件\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        } else {
            if (!copyFileLinux(argv[2], tempInput)) {
                printf("无法复制输入文件到临时目录\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        }
    }
    int ret = runExe(argv[1], needTemp ? tempDir : nullptr);
    if (!willOutputIsCon) {
        if (progOutputIsCon) {
            dumpFileToStdout(tempOutput);
        } else {
            copyFileLinux(tempOutput, argv[3]);
        }
    }
    if (needTemp) removeDir(tempDir);
    return ret;
}
