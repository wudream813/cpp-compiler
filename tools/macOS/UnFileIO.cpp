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

bool shouldExclude(const char* name, const char* exclude1, const char* exclude2, const char* exclude3, const char* exclude4) {
    if (!name) return false;
    const char* base = strrchr(name, '/');
    if (base) base++; else base = name;
    const char* b2 = strrchr(name, '\\');
    if (b2 && (!base || b2 > base)) base = b2 + 1;
    const char* exs[] = {exclude1, exclude2, exclude3, exclude4};
    for (int i=0;i<4;i++) if (exs[i] && exs[i][0]) {
        const char* eb = strrchr(exs[i], '/');
        if (eb) eb++; else eb = exs[i];
        const char* eb2 = strrchr(exs[i], '\\');
        if (eb2 && (!eb || eb2 > eb)) eb = eb2 + 1;
        if (strcmp(base, eb)==0 || strcmp(name, exs[i])==0) return true;
    }
    return false;
}

void copyFileContent(const char* src, const char* dst) {
    int in = open(src, O_RDONLY);
    if (in < 0) return;
    int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) { close(in); return; }
    char buf[8192];
    ssize_t n;
    while ((n = read(in, buf, sizeof(buf))) > 0) write(out, buf, n);
    close(in); close(out);
}

void mirrorWorkDirRecursive(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    DIR* d = opendir(workDir);
    if (!d) return;
    struct dirent* e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        if (shouldExclude(e->d_name, ex1, ex2, ex3, ex4)) continue;
        char src[PATH_MAX], dst[PATH_MAX];
        snprintf(src, sizeof(src), "%s/%s", workDir, e->d_name);
        snprintf(dst, sizeof(dst), "%s/%s", tempDir, e->d_name);
        struct stat st;
        if (lstat(src, &st) != 0) continue;
        if (S_ISLNK(st.st_mode)) {
            char linkTarget[PATH_MAX];
            ssize_t len = readlink(src, linkTarget, sizeof(linkTarget)-1);
            if (len > 0) {
                linkTarget[len]=0;
                symlink(linkTarget, dst);
            }
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            mkdir(dst, 0755);
            mirrorWorkDirRecursive(src, dst, ex1, ex2, ex3, ex4);
        } else if (S_ISREG(st.st_mode)) {
            copyFileContent(src, dst);
        }
    }
    closedir(d);
}

void mirrorWorkDir(const char* workDir, const char* tempDir, const char* ex1, const char* ex2, const char* ex3, const char* ex4) {
    if (!workDir || !*workDir) return;
    struct stat st;
    if (stat(workDir, &st)!=0 || !S_ISDIR(st.st_mode)) return;
    char realWork[PATH_MAX], realTemp[PATH_MAX];
    if (realpath(workDir, realWork) && realpath(tempDir, realTemp)) {
        if (strncmp(realWork, realTemp, strlen(realTemp))==0 || strncmp(realTemp, realWork, strlen(realWork))==0) return;
    }
    mirrorWorkDirRecursive(workDir, tempDir, ex1, ex2, ex3, ex4);
}

void ensureParentDirPosix(const char* filePath) {
    char tmp[PATH_MAX];
    strncpy(tmp, filePath, sizeof(tmp)-1);
    tmp[sizeof(tmp)-1]=0;
    char* slash = strrchr(tmp, '/');
    if (!slash) return;
    *slash = 0;
    char cur[PATH_MAX] = "";
    if (tmp[0] == '/') { strcpy(cur, "/"); }
    char* p = strtok(tmp[0]=='/' ? tmp+1 : tmp, "/");
    char built[PATH_MAX] = "";
    if (tmp[0]=='/') strcpy(built, "/");
    while (p) {
        if (strlen(built) > 1 || built[0]!='/') {
            if (strlen(built)>0 && built[strlen(built)-1]!='/') strcat(built, "/");
        }
        strcat(built, p);
        mkdir(built, 0755);
        p = strtok(nullptr, "/");
    }
}

bool fileExistsPosix(const char* path) {
    struct stat st;
    return stat(path, &st)==0;
}

void backupFilePosix(const char* path, char* backupPath, size_t sz) {
    backupPath[0]=0;
    if (!fileExistsPosix(path)) return;
    snprintf(backupPath, sz, "%s.dream_bak_%d", path, (int)getpid());
    rename(path, backupPath);
}

void restoreFilePosix(const char* path, const char* backupPath) {
    if (backupPath && *backupPath) {
        unlink(path);
        rename(backupPath, path);
    } else {
        unlink(path);
    }
}



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
        if (!lstat(buf, &statbuf)) {
            if (S_ISLNK(statbuf.st_mode)) unlink(buf);
            else if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
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
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 6) { workDir = argv[4]; workDirDirect = argv[5][0]=='1'; }
    else if (argc == 5) workDir = argv[4];
    else if (argc != 4) {
        printf("用法：UnFileIO <command> <inputFile> <outputFile>\n");
        return -1;
    }
    bool inputIsCon = isConsoleFile(argv[2]);
    bool outputIsCon = isConsoleFile(argv[3]);
    if (inputIsCon && outputIsCon) {
        return runExe(argv[1], nullptr);
    }
    if (workDirDirect && workDir && *workDir) {
        char directInput[PATH_MAX] = {0}, directOutput[PATH_MAX] = {0};
        char backupInput[PATH_MAX] = {0}, backupOutput[PATH_MAX] = {0};
        if (!inputIsCon) {
            snprintf(directInput, sizeof(directInput), "%s/%s", workDir, argv[2]);
            ensureParentDirPosix(directInput);
            backupFilePosix(directInput, backupInput, sizeof(backupInput));
            if (!writeStdinToFile(directInput)) {
                if (backupInput[0]) rename(backupInput, directInput);
                return -1;
            }
        }
        if (!outputIsCon) {
            snprintf(directOutput, sizeof(directOutput), "%s/%s", workDir, argv[3]);
            ensureParentDirPosix(directOutput);
            backupFilePosix(directOutput, backupOutput, sizeof(backupOutput));
        }
        int ret = runExe(argv[1], workDir);
        if (!outputIsCon) {
            int fd = open(directOutput, O_RDONLY);
            if (fd < 0) {
                printf("错误：无法打开输出文件");
            } else {
                char buffer[4096];
                ssize_t bytes;
                while ((bytes = read(fd, buffer, sizeof(buffer))) > 0) {
                    write(STDOUT_FILENO, buffer, bytes);
                }
                close(fd);
            }
            if (backupOutput[0]) {
                unlink(directOutput);
                rename(backupOutput, directOutput);
            } else {
                unlink(directOutput);
            }
        }
        if (!inputIsCon) {
            if (backupInput[0]) {
                unlink(directInput);
                rename(backupInput, directInput);
            } else {
                unlink(directInput);
            }
        }
        return ret;
    }


    char tempDir[MAX_PATH], tempInput[MAX_PATH], tempOutput[MAX_PATH];
    if (!createTempSubDir(tempDir, sizeof(tempDir))) return -1;

    if (!inputIsCon) snprintf(tempInput, MAX_PATH, "%s/%s", tempDir, argv[2]);
    if (!outputIsCon) snprintf(tempOutput, MAX_PATH, "%s/%s", tempDir, argv[3]);
    if (workDir && *workDir) {
        mirrorWorkDir(workDir, tempDir, argv[2], argv[3], nullptr, nullptr);
    }

    if (!inputIsCon && !writeStdinToFile(tempInput)) {
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
