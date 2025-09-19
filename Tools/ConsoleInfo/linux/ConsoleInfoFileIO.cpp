#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>

// 获取当前时间（微秒）
long long now_us() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}

int main(int argc, char* argv[]) {
	if (argc != 4) {
		printf("用法：ConsoleInfoFileIO <command> <inputFile> <outputFile>\n");
		return -1;
	}

	// 打开输入文件
	int fd_in = open(argv[2], O_RDONLY);
	if (fd_in < 0) {
		perror("打开输入文件失败");
		return -1;
	}

	// 打开输出文件
	int fd_out = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if (fd_out < 0) {
		perror("打开输出文件失败");
		close(fd_in);
		return -1;
	}

	long long start_us = now_us();

	pid_t pid = fork();
	if (pid < 0) {
		perror("fork 失败");
		close(fd_in);
		close(fd_out);
		return -1;
	}

	if (pid == 0) {
		// 子进程：重定向 stdin/stdout/stderr
		dup2(fd_in, STDIN_FILENO);
		dup2(fd_out, STDOUT_FILENO);
		dup2(fd_out, STDERR_FILENO);

		close(fd_in);
		close(fd_out);

		// 执行命令
		execlp(argv[1], argv[1], (char*)NULL);
		perror("exec 失败");
		exit(127);
	}

	// 父进程：关闭文件描述符
	close(fd_in);
	close(fd_out);

	int status;
	struct rusage usage;
	if (wait4(pid, &status, 0, &usage) < 0) {
		perror("wait4 失败");
		return -1;
	}

	long long end_us = now_us();
	long long exec_time_us = end_us - start_us;

	// CPU 时间
	double user_time = usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6;
	double sys_time = usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;

	// 内存峰值 (KB)
	long mem_kb = usage.ru_maxrss;

	// 程序退出码
	int returnValue = -1;
	if (WIFEXITED(status)) {
		returnValue = WEXITSTATUS(status);
	}

	// 输出结果
	printf("\n-----------------------------------------------");
	printf("\n总执行时间：%lld.%03lld ms", exec_time_us / 1000, exec_time_us % 1000);
	printf("\n内存使用：%ld KB", mem_kb);
	printf("\nCPU内核时间：%.3f 秒", sys_time);
	printf("\nCPU用户时间：%.3f 秒", user_time);
	printf("\n总CPU时间：%.3f 秒", sys_time + user_time);
	printf("\n程序返回值：%d (0x%X)", returnValue, returnValue);
	printf("\n-----------------------------------------------\n");

	return 0;
}
