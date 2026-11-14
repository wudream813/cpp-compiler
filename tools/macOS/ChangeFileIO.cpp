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
                if (!lstat(buf, &statbuf)) {
                    if (S_ISLNK(statbuf.st_mode))
                        unlink(buf);
                    else if (S_ISDIR(statbuf.st_mode))
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
    string baseStr = base;
    if (baseStr.back() == '/') baseStr.pop_back();
    // 加入 pid 与随机数，避免同一秒并发冲突
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld_%d_%d", baseStr.c_str(), (long long)time(NULL), (int)getpid(), rand() % 10000);
    char parentDir[MAX_PATH];
    snprintf(parentDir, MAX_PATH, "%s/dream-cpp-compiler", baseStr.c_str());
    mkdir(parentDir, 0755);
    return mkdir(tempDir, 0755) == 0 || errno == EEXIST;
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
    const char* workDir = "";
    bool workDirDirect = false;
    if (argc == 8) { workDir = argv[6]; workDirDirect = argv[7][0]=='1'; }
    else if (argc == 7) workDir = argv[6];
    else if (argc != 6) {
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
    if (workDirDirect && workDir && *workDir) {
        char directInput[PATH_MAX] = {0}, directOutput[PATH_MAX] = {0};
        char backupInput[PATH_MAX] = {0}, backupOutput[PATH_MAX] = {0};
        if (!willInputIsCon) {
            snprintf(directInput, sizeof(directInput), "%s/%s", workDir, argv[4]);
            ensureParentDirPosix(directInput);
            backupFilePosix(directInput, backupInput, sizeof(backupInput));
            if (progInputIsCon) {
                if (!writeStdinToFile(directInput)) {
                    if (backupInput[0]) rename(backupInput, directInput);
                    return -1;
                }
            } else {
                backupFilePosix(argv[2], nullptr, 0); // not needed
                if (!copyFileLinux(argv[2], directInput)) {
                    if (backupInput[0]) rename(backupInput, directInput);
                    printf("无法复制输入文件到工作目录\n");
                    return -1;
                }
            }
        }
        if (!willOutputIsCon) {
            snprintf(directOutput, sizeof(directOutput), "%s/%s", workDir, argv[5]);
            ensureParentDirPosix(directOutput);
            backupFilePosix(directOutput, backupOutput, sizeof(backupOutput));
        }
        int ret = runExe(argv[1], workDir);
        if (!willOutputIsCon) {
            if (progOutputIsCon) {
                dumpFileToStdout(directOutput);
                unlink(directOutput);
                if (backupOutput[0]) rename(backupOutput, directOutput);
            } else {
                copyFileLinux(directOutput, argv[3]);
                unlink(directOutput);
                if (backupOutput[0]) rename(backupOutput, directOutput);
            }
        }
        if (!willInputIsCon) {
            if (backupInput[0]) {
                unlink(directInput);
                rename(backupInput, directInput);
            } else {
                unlink(directInput);
            }
        }
        return ret;
    }
    const char* commandArg = argv[1];
    const char* programInput = argv[2];
    const char* programOutput = argv[3];
    const char* willInput = argv[4];
    const char* willOutput = argv[5];
    char tempDir[MAX_PATH], tempInput[MAX_PATH] = {0}, tempOutput[MAX_PATH] = {0};
    bool needTemp = !willInputIsCon || !willOutputIsCon;
    if (needTemp) {
        if (!createTempSubDir(tempDir, sizeof(tempDir))) {
            printf("无法创建临时目录\n");
            return -1;
        }
        if (!willInputIsCon) snprintf(tempInput, MAX_PATH, "%s/%s", tempDir, willInput);
        if (!willOutputIsCon) snprintf(tempOutput, MAX_PATH, "%s/%s", tempDir, willOutput);
    } else {
        tempDir[0] = 0;
    }
    if (needTemp && workDir && *workDir) {
        mirrorWorkDir(workDir, tempDir, argv[2], argv[3], argv[4], argv[5]);
    }
    if (!willInputIsCon) {
        if (progInputIsCon) {
            if (!writeStdinToFile(tempInput)) {
                printf("无法从控制台读取输入到临时目录\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        } else {
            if (!copyFileMac(programInput, tempInput)) {
                printf("无法复制输入文件到临时目录\n");
                if (needTemp) removeDir(tempDir);
                return -1;
            }
        }
    }
    int ret = runExe(commandArg, needTemp ? tempDir : nullptr);
    if (!willOutputIsCon) {
        if (progOutputIsCon) {
            dumpFileToStdout(tempOutput);
        } else {
            copyFileMac(tempOutput, programOutput);
        }
    }
    if (needTemp) removeDir(tempDir);
    return ret;
}
