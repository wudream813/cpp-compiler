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
            if (!stat(buf, &statbuf)) {
                if (S_ISDIR(statbuf.st_mode)) removeDir(buf);
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
    snprintf(tempDir, size, "%s/dream-cpp-compiler/tmp_%lld", base, (long long)time(NULL));
    return mkdir(tempDir, 0777) == 0;
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

    char tempDir[PATH_MAX], tempInput[PATH_MAX], tempOutput[PATH_MAX];

    if (!createTempSubDir(tempDir, sizeof(tempDir))) {
        printf("无法创建临时目录\n");
        return -1;
    }

    snprintf(tempInput, PATH_MAX, "%s/%s", tempDir, argv[4]);
    snprintf(tempOutput, PATH_MAX, "%s/%s", tempDir, argv[5]);

    if (!copyFileLinux(argv[2], tempInput)) {
        printf("无法复制输入文件到临时目录\n");
        removeDir(tempDir);
        return -1;
    }

    int ret = runExe(argv[1], tempDir);

    copyFileLinux(tempOutput, argv[3]);
    removeDir(tempDir);

    return ret;
}
